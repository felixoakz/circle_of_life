// iNaturalist (PLAN §6.1 stage B): a photo for taxa whose Wikidata item
// has no image, and the taxon page for the links.
//
// Only photos under an open licence we may show in a non-commercial
// portfolio are used: CC0, CC BY, CC BY-SA and CC BY-NC. A photo with no
// licence code is "all rights reserved" and is never used. At most one
// request per second (Enricher.getText).
//
// Concepts introduced here:
// - (none beyond the package's)

package enrich

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
)

// AllowedLicenses are the licence codes we may show (iNat's spelling).
var AllowedLicenses = [4]string{"cc0", "cc-by", "cc-by-sa", "cc-by-nc"}

// INatTaxon is an iNaturalist taxon that matched the name exactly.
type INatTaxon struct {
	ID uint64
	// Image is its default photo, if it has one under an allowed licence.
	Image *Image
}

type taxaResponse struct {
	Results []struct {
		// Pointers, so a result without id or name is an error, not a
		// taxon 0 named "".
		ID           *uint64    `json:"id"`
		Name         *string    `json:"name"`
		DefaultPhoto *inatPhoto `json:"default_photo"`
	} `json:"results"`
}

type inatPhoto struct {
	LicenseCode *string `json:"license_code"`
	Attribution *string `json:"attribution"`
	MediumURL   *string `json:"medium_url"`
	ID          *uint64 `json:"id"`
}

// LicenseLabel turns "cc-by-nc" into "CC BY-NC" and its Creative Commons
// deed URL; false for a code we do not allow.
func LicenseLabel(code string) (label, deed string, ok bool) {
	switch code {
	case "cc0":
		return "CC0", "https://creativecommons.org/publicdomain/zero/1.0/", true
	case "cc-by":
		return "CC BY", "https://creativecommons.org/licenses/by/4.0/", true
	case "cc-by-sa":
		return "CC BY-SA", "https://creativecommons.org/licenses/by-sa/4.0/", true
	case "cc-by-nc":
		return "CC BY-NC", "https://creativecommons.org/licenses/by-nc/4.0/", true
	}
	return "", "", false
}

// CreditName turns "(c) Olli Pihlajamaa, some rights reserved (CC BY-NC),
// uploaded by Olli Pihlajamaa" into "Olli Pihlajamaa"; it falls back to the
// whole (trimmed) string.
func CreditName(attribution string) string {
	rest := attribution
	if after, found := strings.CutPrefix(attribution, "(c) "); found {
		rest = after
	} else if after, found := strings.CutPrefix(attribution, "© "); found {
		rest = after
	}
	for _, marker := range []string{", some rights reserved", ", no rights reserved"} {
		if name, _, found := strings.Cut(rest, marker); found {
			return strings.TrimSpace(name)
		}
	}
	return strings.TrimSpace(attribution)
}

// ParseTaxa is the result whose name is exactly name (the search is fuzzy),
// with its photo kept only if the licence is allowed; nil if none matches.
func ParseTaxa(body []byte, name string) (*INatTaxon, error) {
	var response taxaResponse
	if err := json.Unmarshal(body, &response); err != nil {
		return nil, err
	}
	// Check every result first: the whole response is rejected if any
	// result lacks an id or a name.
	for _, result := range response.Results {
		if result.ID == nil || result.Name == nil {
			return nil, errors.New("iNaturalist taxon without id or name")
		}
	}
	for _, result := range response.Results {
		if *result.Name != name {
			continue
		}
		taxon := &INatTaxon{ID: *result.ID}
		if result.DefaultPhoto != nil {
			taxon.Image = photoImage(*result.DefaultPhoto, *result.ID)
		}
		return taxon, nil
	}
	return nil, nil
}

// photoImage is photo as an Image, or nil unless its licence is allowed.
func photoImage(photo inatPhoto, taxonID uint64) *Image {
	// No licence code means all rights reserved: never used.
	if photo.LicenseCode == nil || !slices.Contains(AllowedLicenses[:], *photo.LicenseCode) {
		return nil
	}
	label, deed, ok := LicenseLabel(*photo.LicenseCode)
	if !ok || photo.MediumURL == nil {
		return nil
	}
	pageURL := fmt.Sprintf("https://www.inaturalist.org/taxa/%d", taxonID)
	if photo.ID != nil {
		pageURL = fmt.Sprintf("https://www.inaturalist.org/photos/%d", *photo.ID)
	}
	image := &Image{
		URL:        *photo.MediumURL,
		License:    label,
		LicenseURL: new(deed),
		Source:     SourceINat,
		PageURL:    pageURL,
	}
	if photo.Attribution != nil {
		image.Credit = new(CreditName(*photo.Attribution))
	}
	return image
}

// inatLookup is the exact-name iNaturalist taxon; name "" means "do not
// ask".
func (e *Enricher) inatLookup(ctx context.Context, report *Report, name string) *INatTaxon {
	if name == "" {
		return nil
	}
	rawURL := e.Endpoints.INat + "/taxa"
	query := url.Values{}
	query.Set("q", name)
	query.Set("per_page", "5")
	body, ok := e.getText(ctx, report, HostINat, SourceINat, rawURL, query)
	if !ok {
		return nil
	}
	taxon, err := ParseTaxa(body, name)
	if err != nil {
		report.Fail(SourceINat, fmt.Sprintf("taxa %s: %v", name, err))
		return nil
	}
	return taxon
}
