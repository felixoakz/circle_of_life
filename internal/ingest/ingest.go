// Package ingest is `species ingest`: it turns the raw synth tree and
// taxonomy into tree.db (ARCHITECTURE §3).
//
// The steps: parse the tree, read the taxonomy, compute the layout, groups
// and LOD levels, read the GBIF common names (with --vernacular, P11), cut
// and gzip the tiles, and write tree.db (via <out>.tmp and an atomic
// rename). Every step prints its timing; the end prints the database size,
// tile statistics and peak memory. With --dry-run it stops before the tiles
// and writes nothing.
//
// Concepts introduced here:
// - timing work with `time.Now` and `time.Since`
// - formatted output with `fmt.Fprintf` and width/precision verbs
// - reading /proc/self/status to learn about our own process
package ingest

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"species/internal/config"
	"species/internal/db"
	"species/internal/tiles"
	"species/internal/tree"
	"species/internal/vernacular"
)

// MaxTileGz is the largest gzipped tile we accept (ARCHITECTURE §3.6): above it,
// tree.P should be lowered to 256.
const MaxTileGz = 120 * 1024

// Run runs `species ingest`, printing its report to out.
func Run(args config.Ingest, out io.Writer) error {
	total := time.Now()

	// LEARN: time.Now() reads the wall clock and, alongside it, a
	// monotonic clock (one that never jumps back when the system time is
	// adjusted). time.Since(start) subtracts using the monotonic reading,
	// so it is safe for timing; it returns a time.Duration, and
	// .Seconds() turns that into a float64.
	started := time.Now()
	t, err := tree.ParseNewickFile(args.Tree)
	if err != nil {
		return err
	}
	parseTime := time.Since(started)

	started = time.Now()
	x, err := tree.ReadTaxonomy(args.Taxonomy, t)
	if err != nil {
		return err
	}
	taxonomyTime := time.Since(started)

	started = time.Now()
	l, err := tree.ComputeLayout(t)
	if err != nil {
		return err
	}
	layoutTime := time.Since(started)

	// LEARN: in a format verb, a number before the letter is the width and
	// one after a dot the precision: %10s right-aligns a string in 10
	// columns, %-15s left-aligns it, and %9.1f prints a float in 9 columns
	// with one decimal. fmt.Fprintf writes to any io.Writer (os.Stdout in
	// main, io.Discard in tests).
	fmt.Fprintf(out, "nodes             %10s\n", thousands(t.Len()))
	fmt.Fprintf(out, "tips              %10s\n", thousands(t.TipCount()))
	fmt.Fprintf(out, "mrca nodes        %10s\n", thousands(t.MrcaCount()))
	fmt.Fprintf(out, "taxonomy rows     %10s\n", thousands(x.RowsRead))
	fmt.Fprintf(out, "missing taxonomy  %10s\n", thousands(x.Missing))
	fmt.Fprintf(out, "parse tree        %9.1fs\n", parseTime.Seconds())
	fmt.Fprintf(out, "read taxonomy     %9.1fs\n", taxonomyTime.Seconds())
	fmt.Fprintf(out, "layout            %9.1fs\n", layoutTime.Seconds())
	printLayout(out, t, l)

	var names *vernacular.Vernaculars // nil: no common names
	if args.Vernacular != "" {
		started := time.Now()
		names, err = readVernaculars(out, args.Vernacular, args.Langs, x, l)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "common names      %9.1fs\n", time.Since(started).Seconds())
		if err := printVernaculars(out, names, args.Langs); err != nil {
			return err
		}
	}

	if !args.DryRun {
		started := time.Now()
		set, err := tiles.Build(t, x, l)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "tiles             %9.1fs\n", time.Since(started).Seconds())
		printTiles(out, set)

		started = time.Now()
		bytes, err := db.Write(args.Out, t, x, l, set, names)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "write db          %9.1fs\n", time.Since(started).Seconds())
		fmt.Fprintf(out, "database          %7s MB  %s\n", thousands(int(bytes/(1024*1024))), args.Out)
		fmt.Fprintf(out, "dataVersion       %s\n", db.DataVersion(set.Hash))
	}

	fmt.Fprintf(out, "total             %9.1fs\n", time.Since(total).Seconds())
	if mb, ok := peakRSSMB(); ok {
		fmt.Fprintf(out, "peak RSS          %7s MB\n", thousands(mb))
	} else {
		fmt.Fprintln(out, "peak RSS          (unknown on this OS)")
	}
	return nil
}

// readVernaculars reads the GBIF common names for our nodes (P11), joined
// through the gbif: ids OTT lists in sourceinfo. A GBIF key on two nodes
// stays with the first in pre-order.
func readVernaculars(out io.Writer, source, langs string, x *tree.Taxonomy, l *tree.Layout) (*vernacular.Vernaculars, error) {
	nodeOfGBIF := map[uint32]uint32{}
	scientific := make([]string, 0, l.Len())
	shared := 0
	for id := 0; id < l.Len(); id++ {
		node := int(l.Node[id])
		name, _ := x.Name(node) // "" when the node has no taxon
		scientific = append(scientific, name)
		taxon, ok := x.Taxon(node)
		if !ok || taxon.GBIF == tree.NoID {
			continue
		}
		// A GBIF key on two OTT taxa is rare; the first in pre-order (the
		// ancestor) keeps it.
		if _, taken := nodeOfGBIF[taxon.GBIF]; taken {
			shared++
		} else {
			nodeOfGBIF[taxon.GBIF] = uint32(id)
		}
	}
	fmt.Fprintf(out, "nodes with gbif   %10s\n", thousands(len(nodeOfGBIF)))
	if shared > 0 {
		fmt.Fprintf(out, "shared gbif keys  %10s\n", thousands(shared))
	}
	return vernacular.Read(source, langs, nodeOfGBIF, scientific)
}

// printVernaculars prints the common-name counts.
func printVernaculars(out io.Writer, v *vernacular.Vernaculars, langs string) error {
	fmt.Fprintf(out, "vernacular rows   %10s\n", thousands(v.RowsRead))
	fmt.Fprintf(out, "  in %-12s %10s\n", langs, thousands(v.RowsInLangs))
	fmt.Fprintf(out, "  not in tree     %10s\n", thousands(v.Unmatched))
	fmt.Fprintf(out, "  duplicates      %10s\n", thousands(v.Duplicates))
	wanted, err := vernacular.ParseLangs(langs)
	if err != nil {
		return err
	}
	for _, lang := range wanted {
		fmt.Fprintf(out, "names kept %-6s %10s\n", lang, thousands(v.Count(lang)))
	}
	fmt.Fprintf(out, "nodes with names  %10s\n", thousands(v.NodesCovered()))
	return nil
}

// printTiles prints tile count, sizes, and the largest tile against
// MaxTileGz.
func printTiles(out io.Writer, set *tiles.Set) {
	gzTotal := 0
	rawTotal := 0
	largest := set.Tiles[0]
	var mostNodes uint32
	for _, tile := range set.Tiles {
		gzTotal += len(tile.Gz)
		rawTotal += tile.RawLen
		mostNodes = max(mostNodes, tile.Count)
		if len(tile.Gz) > len(largest.Gz) {
			largest = tile
		}
	}
	fmt.Fprintf(out, "tile count        %10s\n", thousands(len(set.Tiles)))
	fmt.Fprintf(out, "tiles total       %7s KB gz, %s KB raw\n", thousands(gzTotal/1024), thousands(rawTotal/1024))
	fmt.Fprintf(out, "largest tile      %7s KB gz, %s KB raw, %s nodes (level %d, sector %d)\n",
		thousands(len(largest.Gz)/1024), thousands(largest.RawLen/1024), thousands(int(largest.Count)),
		largest.Level, largest.Sector)
	fmt.Fprintf(out, "most nodes/tile   %10s\n", thousands(int(mostNodes)))
	if len(largest.Gz) > MaxTileGz {
		fmt.Fprintf(out, "WARNING: largest tile exceeds %d KB gz; lower lod::P to 256 (ARCHITECTURE §3.6)\n", MaxTileGz/1024)
	}
}

// printLayout prints group totals, the level histogram, group runs and a
// Homo sapiens sanity line.
func printLayout(out io.Writer, t *tree.Tree, l *tree.Layout) {
	var tipsPerGroup [tree.GroupCount]int
	ungroupedTips := 0
	nodesPerLevel := make([]int, int(l.MaxLevel)+1)
	for id := 0; id < l.Len(); id++ {
		nodesPerLevel[l.Level[id]]++
		if l.IsTip(id) {
			group := int(l.Group[id])
			if group < tree.GroupCount {
				tipsPerGroup[group]++
			} else {
				ungroupedTips++
			}
		}
	}

	fmt.Fprintln(out, "tips per group")
	for group, tips := range tipsPerGroup {
		fmt.Fprintf(out, "  %-15s %10s\n", tree.GroupName(uint8(group)), thousands(tips))
	}
	if ungroupedTips > 0 {
		fmt.Fprintf(out, "  %-15s %10s  (should be 0)\n", "no group", thousands(ungroupedTips))
	}

	fmt.Fprintf(out, "nodes per level (P = %d, Lmax = %d)\n", tree.P, l.MaxLevel)
	for level, nodes := range nodesPerLevel {
		fmt.Fprintf(out, "  %2d              %10s\n", level, thousands(nodes))
	}

	fmt.Fprintf(out, "group runs        %10d\n", len(l.GroupRuns))
	for _, run := range l.GroupRuns {
		percent := 100 * float64(run.Tips) / float64(l.TipCount)
		fmt.Fprintf(out, "  %-15s %10s tips %6.2f%% of the circle\n",
			tree.GroupName(run.Group), thousands(int(run.Tips)), percent)
	}

	id, ok := tiles.HomeID(t, l)
	if !ok {
		fmt.Fprintln(out, "Homo sapiens      not in the tree")
		return
	}
	// FormatFloat(…, 'f', -1, 32) is the shortest text that reads back as
	// the same float32 (0.724, not 0.72399998).
	r := strconv.FormatFloat(float64(l.R[id]), 'f', -1, 32)
	fmt.Fprintf(out, "Homo sapiens      id %d depth %d tips %d angle %d (%.4f turns) r %s level %d group %s\n",
		id, l.Depth[id], l.LeafCount[id], l.Angle[id], float64(l.Angle[id])/4_294_967_296.0,
		r, l.Level[id], tree.GroupName(l.Group[id]))
}

// thousands formats 2725682 as "2,725,682", so the counts are easy to
// compare with ARCHITECTURE §2.2.
func thousands(n int) string {
	digits := strconv.Itoa(n)
	var out strings.Builder
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out.WriteByte(',')
		}
		out.WriteByte(digits[i])
	}
	return out.String()
}

// peakRSSMB is the most memory this process has held at once, in MB
// (VmHWM, the "high water mark", in /proc/self/status); false where that
// file does not exist.
func peakRSSMB() (int, bool) {
	status, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(string(status), "\n") {
		// The line looks like `VmHWM:   1234567 kB`.
		rest, found := strings.CutPrefix(line, "VmHWM:")
		if !found {
			continue
		}
		kb, err := strconv.Atoi(strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(rest), "kB")))
		if err != nil {
			return 0, false
		}
		return kb / 1024, true
	}
	return 0, false
}
