import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// Serializes writes so two overlapping async requests can't interleave a
// read-modify-write and clobber each other's changes. Node is single-threaded
// but `await` points inside a read-modify-write are exactly where that race
// can happen.
let writeLock = Promise.resolve();

function withWriteLock(fn) {
  const result = writeLock.then(fn, fn);
  // Don't let one failed write wedge the queue forever for later callers.
  writeLock = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function createLocalStore(dataFilePath) {
  async function ensureDataFile() {
    await fs.mkdir(path.dirname(dataFilePath), { recursive: true });
    try {
      await fs.access(dataFilePath);
    } catch {
      await writeAllAtomic([]);
    }
  }

  async function readAll() {
    try {
      const raw = await fs.readFile(dataFilePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code === "ENOENT") return [];
      // A corrupt file is a real failure, not "no events" — surface it
      // rather than silently returning an empty calendar.
      throw new Error(`calendar: failed to read events.json: ${err.message}`);
    }
  }

  async function writeAllAtomic(events) {
    const dir = path.dirname(dataFilePath);
    const tmpPath = path.join(dir, `.events-${randomUUID()}.tmp`);
    await fs.writeFile(tmpPath, JSON.stringify(events, null, 2), "utf8");
    // rename() is atomic on the same filesystem — a crash mid-write leaves
    // the previous events.json intact instead of a truncated file.
    await fs.rename(tmpPath, dataFilePath);
  }

  return {
    async init() {
      await ensureDataFile();
    },

    async listEvents({ from, to }) {
      const events = await readAll();
      const fromMs = new Date(from).getTime();
      const toMs = new Date(to).getTime();
      return events
        .filter((e) => {
          const startMs = new Date(e.start).getTime();
          return startMs >= fromMs && startMs < toMs;
        })
        .sort((a, b) => new Date(a.start) - new Date(b.start));
    },

    async createEvent(input) {
      return withWriteLock(async () => {
        const events = await readAll();
        const now = new Date().toISOString();
        const event = {
          id: randomUUID(),
          provider: "local",
          title: input.title,
          start: input.start,
          end: input.end,
          allDay: Boolean(input.allDay),
          notes: input.notes,
          createdAt: now,
          updatedAt: now,
        };
        events.push(event);
        await writeAllAtomic(events);
        return event;
      });
    },

    // Reserved per the architecture doc's CalendarProvider interface —
    // intentionally unimplemented in M1 (delete-and-recreate covers today's
    // needs; a real edit UI is what would justify building this out).
    async updateEvent() {
      throw new Error("updateEvent is not implemented yet (M1 scope) — delete and recreate instead");
    },

    async deleteEvent(id) {
      return withWriteLock(async () => {
        const events = await readAll();
        const next = events.filter((e) => e.id !== id);
        if (next.length === events.length) {
          const err = new Error(`No event with id ${id}`);
          err.code = "NOT_FOUND";
          throw err;
        }
        await writeAllAtomic(next);
      });
    },
  };
}
