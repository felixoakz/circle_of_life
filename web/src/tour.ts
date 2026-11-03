// The idle tour (DESIGN.md §6): left alone, the app moves from species to
// species. FIRST_MS after a plain visit, then after DWELL_MS on each
// selection, it picks the next one from a
// curated list (recognisable species spread over the kingdoms and round
// the wheel, most with a photo and a common name), turns the wheel to it
// and the card follows. The list is shuffled and not repeated until it is
// used up; the tour starts from Homo sapiens, the default selection.
//
// Any real input (pointer down, wheel, key, search, click) stops it; it
// starts again after RESUME_DWELLS dwells with no input. Pointer movement
// in the last POINTER_HOLD_MS, a touch in the last TOUCH_HOLD_MS, the
// pointer resting on the card, focus in the card, scrolling it, a text
// selection, a flight, a loading selection, an open search or a hidden tab
// hold the countdown (main.ts); a pointer resting on the wheel does not.
// While it runs the readout says so with a Stop button, and the wordmark
// menu switches it off and on (`setEnabled`). A deep link (?n=) starts stopped, so a shared
// species stays put for RESUME_MS before the tour moves on. Tour steps
// replace the URL instead of pushing history. Off under reduced motion
// and `?still`, unless `?tour=<seconds>` asks for it (tests, screenshots),
// which also sets the dwell (the resume time is three dwells).

/**
 * The tour's species: OpenTree ids checked against otl16.1 (`/api/search`),
 * with a common name and the kingdom key's group id (ui/hud.ts), which the
 * search palette's "Try" list shows too. E. coli has no species node in the
 * synthesis, so Bacillus subtilis stands for bacteria.
 */
export const TOUR: readonly { id: string; name: string; common: string | null; group: number }[] = [
  { id: 'ott42314', name: 'Panthera tigris', common: 'Tiger', group: 0 },
  { id: 'ott226190', name: 'Balaenoptera musculus', common: 'Blue whale', group: 0 },
  { id: 'ott239659', name: 'Quercus robur', common: 'English oak', group: 2 },
  { id: 'ott75257', name: 'Amanita muscaria', common: 'Fly agaric', group: 1 },
  { id: 'ott110468', name: 'Octopus vulgaris', common: 'Common octopus', group: 0 },
  { id: 'ott1084928', name: 'Bacillus subtilis', common: 'Hay bacillus', group: 4 },
  { id: 'ott461645', name: 'Apis mellifera', common: 'Western honey bee', group: 0 },
  { id: 'ott872573', name: 'Ailuropoda melanoleuca', common: 'Giant panda', group: 0 },
  { id: 'ott810380', name: 'Sequoiadendron giganteum', common: 'Giant sequoia', group: 2 },
  { id: 'ott190091', name: 'Danaus plexippus', common: 'Monarch butterfly', group: 0 },
  { id: 'ott554297', name: 'Carcharodon carcharias', common: 'Great white shark', group: 0 },
  { id: 'ott494370', name: 'Aptenodytes forsteri', common: 'Emperor penguin', group: 0 },
  { id: 'ott541936', name: 'Loxodonta africana', common: 'African bush elephant', group: 0 },
  { id: 'ott994084', name: 'Ginkgo biloba', common: 'Ginkgo', group: 2 },
  { id: 'ott515712', name: 'Helianthus annuus', common: 'Common sunflower', group: 2 },
  { id: 'ott356221', name: 'Saccharomyces cerevisiae', common: 'Baker’s yeast', group: 1 },
  { id: 'ott186590', name: 'Morchella esculenta', common: 'Common morel', group: 1 },
  { id: 'ott201128', name: 'Plasmodium falciparum', common: 'Malaria parasite', group: 3 },
  { id: 'ott33192', name: 'Halobacterium salinarum', common: null, group: 5 },
  { id: 'ott422679', name: 'Physarum polycephalum', common: 'Many-headed slime mould', group: 3 },
  { id: 'ott327624', name: 'Phascolarctos cinereus', common: 'Koala', group: 0 },
  { id: 'ott251385', name: 'Architeuthis dux', common: 'Giant squid', group: 0 },
];

/** Pointer movement holds the countdown for this long after it stops, ms. */
export const POINTER_HOLD_MS = 3000;
/** A touch holds it this long (a phone reader's thumb rests between scrolls), ms. */
export const TOUCH_HOLD_MS = 30_000;
/** Time on each selection before the next, ms. */
export const DWELL_MS = 12_000;
/** Time on the opening selection (Homo sapiens) before the first hop, ms. */
export const FIRST_MS = 15_000;
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
  private hops = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `firstMs`: the wait before the first hop (FIRST_MS on a plain visit; the dwell by default). */
  constructor(now: number, dwellMs = DWELL_MS, random: () => number = Math.random, firstMs = dwellMs) {
    this.dwell = dwellMs;
    this.random = random;
    this.nextAt = now + firstMs;
  }

  /** True while it is stopped by input (tests). */
  isStopped(): boolean {
    return this.stopped;
  }

  /** True once it has moved the selection and nothing has stopped it since: the readout says "Touring". */
  touring(): boolean {
    return this.enabled && !this.stopped && this.hops > 0;
  }

  /** Switches the tour on (the next hop a dwell from now) or off (the wordmark menu, the readout's Stop). */
  setEnabled(on: boolean, now: number): void {
    this.enabled = on;
    this.stopped = false;
    this.hops = 0;
    clearTimeout(this.timer);
    if (!on) return;
    this.nextAt = now + this.dwell;
    this.arm(now);
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
      if (id) {
        this.hops++;
        this.go(id);
      }
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
