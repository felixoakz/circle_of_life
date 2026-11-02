// The idle tour (DESIGN.md §6): left alone, the app moves from species to
// species. After DWELL_MS on a selection it picks the next one from a
// curated list (recognisable species spread over the kingdoms and round
// the wheel, most with a photo and a common name), turns the wheel to it
// and the card follows. The list is shuffled and not repeated until it is
// used up; the tour starts from Homo sapiens, the default selection.
//
// Any real input (pointer down, wheel, key, search, click) stops it; it
// starts again after RESUME_MS with no input. Pointer movement in the last
// POINTER_HOLD_MS, the pointer resting on the card, a flight, a loading
// selection, an open search or a hidden tab hold the countdown; a pointer
// resting on the wheel does not. A deep link (?n=) starts stopped, so a shared
// species stays put for RESUME_MS before the tour moves on. Tour steps
// replace the URL instead of pushing history. Off under reduced motion
// and `?still`, unless `?tour=<seconds>` asks for it (tests, screenshots),
// which also sets the dwell (the resume time is three dwells).

/** The tour's species: OpenTree ids checked against otl16.1 (`/api/search`). E. coli has no species node in the synthesis, so Bacillus subtilis stands for bacteria. */
export const TOUR: readonly { id: string; name: string }[] = [
  { id: 'ott42314', name: 'Panthera tigris' },
  { id: 'ott226190', name: 'Balaenoptera musculus' },
  { id: 'ott239659', name: 'Quercus robur' },
  { id: 'ott75257', name: 'Amanita muscaria' },
  { id: 'ott110468', name: 'Octopus vulgaris' },
  { id: 'ott1084928', name: 'Bacillus subtilis' },
  { id: 'ott461645', name: 'Apis mellifera' },
  { id: 'ott872573', name: 'Ailuropoda melanoleuca' },
  { id: 'ott810380', name: 'Sequoiadendron giganteum' },
  { id: 'ott190091', name: 'Danaus plexippus' },
  { id: 'ott554297', name: 'Carcharodon carcharias' },
  { id: 'ott494370', name: 'Aptenodytes forsteri' },
  { id: 'ott541936', name: 'Loxodonta africana' },
  { id: 'ott994084', name: 'Ginkgo biloba' },
  { id: 'ott515712', name: 'Helianthus annuus' },
  { id: 'ott356221', name: 'Saccharomyces cerevisiae' },
  { id: 'ott186590', name: 'Morchella esculenta' },
  { id: 'ott201128', name: 'Plasmodium falciparum' },
  { id: 'ott33192', name: 'Halobacterium salinarum' },
  { id: 'ott422679', name: 'Physarum polycephalum' },
  { id: 'ott327624', name: 'Phascolarctos cinereus' },
  { id: 'ott251385', name: 'Architeuthis dux' },
];

/** Pointer movement holds the countdown for this long after it stops, ms. */
export const POINTER_HOLD_MS = 3000;
/** Time on each selection before the next, ms. */
export const DWELL_MS = 10_000;
/** Quiet time after an input before the tour starts again, as a multiple of the dwell (30 s). */
export const RESUME_DWELLS = 3;

/** `ids` shuffled (Fisher–Yates) with `random`, so tests can pass their own. */
export function shuffled(ids: readonly string[], random: () => number): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = out[i];
    const u = out[j];
    if (t === undefined || u === undefined) continue;
    out[i] = u;
    out[j] = t;
  }
  return out;
}

export class Tour {
  enabled = true;
  /** Hold the countdown (hover, flight, loading, search, hidden tab). */
  held: () => boolean = () => false;
  /** Selects the next species (selection.ts, motion 'tour'). */
  go: (id: string) => void = () => {};
  /** Asks for a frame when the countdown runs out (the scene's requestRender). */
  wake: () => void = () => {};

  private readonly dwell: number;
  private readonly random: () => number;
  private queue: string[] = [];
  private stopped = false;
  private nextAt: number;
  private last = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(now: number, dwellMs = DWELL_MS, random: () => number = Math.random) {
    this.dwell = dwellMs;
    this.random = random;
    this.nextAt = now + dwellMs;
  }

  /** True while it is stopped by input (tests). */
  isStopped(): boolean {
    return this.stopped;
  }

  /** A real input: stop, and start again after RESUME_DWELLS dwells with no input. */
  interact(now: number): void {
    if (!this.enabled) return;
    this.stopped = true;
    this.nextAt = now + this.dwell * RESUME_DWELLS;
    this.arm(now);
  }

  /** Called every frame (and when its timer fires); hops when the countdown runs out. */
  step(now: number): void {
    const dt = this.last < 0 ? 0 : Math.max(0, now - this.last);
    this.last = now;
    if (!this.enabled) return;
    // A hold pushes the hop back by the time it lasted.
    if (this.held()) {
      this.nextAt += dt;
      this.arm(now);
      return;
    }
    if (now >= this.nextAt) {
      this.stopped = false;
      if (this.queue.length === 0) this.queue = shuffled(TOUR.map((t) => t.id), this.random);
      const id = this.queue.shift();
      this.nextAt = now + this.dwell;
      if (id) this.go(id);
    }
    this.arm(now);
  }

  /** A timer for the next hop, so the tour runs without frames of its own (a still scene stays idle between hops). */
  private arm(now: number): void {
    clearTimeout(this.timer);
    // While held, look again in a while; the hold is counted from frames or this timer.
    const wait = this.held() ? Math.min(1000, this.dwell) : this.nextAt - now;
    this.timer = setTimeout(() => this.wake(), Math.max(0, wait) + 16);
  }
}
