// Sokoban solver: push-optimal search, room by room.
//
// Idea: a level is a hallway with small rooms off it, and a box pushed out
// of its room can never come back, so each room is solved on its own and the
// push counts add up. Inside one room the search is a breadth-first search
// over pushes (not steps): a state is the sorted box squares plus the
// player's reachable region, named by its lowest square. The first solved
// state the queue reaches is therefore push-optimal for that room.
//
// Deadlock pruning, all of it safe (it never removes a solvable state):
//   - live squares: a box can only sit where it could be pulled back from a
//     goal, ignoring the other boxes; anything else is a dead square.
//   - frozen 2x2 blocks: four wall-or-box squares holding a box off a goal.
// Corners and wall segments with no goal fall out of the live-square test.
//
// The search is bounded by a fixed number of states, never by the clock,
// so two runs always write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions in fixed order: up, down, left, right. The order is part of
// the determinism contract: ties always break the same way.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r'];
const PUSH = ['U', 'D', 'L', 'R'];

// Work budgets (state counts, never wall-clock time).
const MAX_ROOM_STATES = 600_000;
const MAX_WHOLE_STATES = 1_200_000;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

type Room = {
  boxes: number[];
  goals: number[];
  done: boolean;
};

/** Parse XSB text into a board; short rows and the outer frame are walls. */
function parseBoard(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * Live squares: from each goal, walk a lone box backwards. A box on square
 * x can be pulled one step to y = x - d when the player can stand on the far
 * side (y - d is open floor) and y itself is open floor. Squares never
 * reached this way can never hold a box on any route to a goal.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = goals.slice();
  for (const g of goals) live[g] = 1;
  for (let head = 0; head < queue.length; head++) {
    const x = queue[head]!;
    for (let k = 0; k < 4; k++) {
      const d = DY[k]! * w + DX[k]!;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (wall[y] || wall[y - d] || live[y]) continue;
      live[y] = 1;
      queue.push(y);
    }
  }
  return live;
}

/**
 * Flood-fill the squares the player reaches from `from` with `occupied`
 * in the way, stamping them in `seen`; returns the lowest square reached,
 * which names the whole region.
 */
function floodRegion(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** True when the box just pushed to `t` is stuck in a frozen 2x2 block. */
function isFrozenBlock(
  board: Board,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = board;
  const starts = [t, t - 1, t - w, t - w - 1];
  for (const a of starts) {
    if (a < 0) continue;
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (d >= wall.length) continue;
    const cells = [a, b, c, d];
    let filled = true;
    let badBox = false;
    for (const cell of cells) {
      if (!wall[cell] && !occupied[cell]) {
        filled = false;
        break;
      }
      if (occupied[cell] && !goal[cell]) badBox = true;
    }
    if (filled && badBox) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, lower letters. */
function walkTo(board: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k]! * w + DX[k]!;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k]!;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: push square out of reach');
  let out = '';
  for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
  return out;
}

/** Where the player stands after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/**
 * Push-optimal solution of one board (a room, or a whole level as a
 * fallback): {pushes, moves}, or null when the state budget runs out or no
 * solution exists. Breadth-first over pushes, so the first solved state
 * found is optimal.
 */
function pushSearch(
  board: Board,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(board);
  if (board.boxes.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  // Numeric state key: region-lowest, then the sorted box squares, packed
  // in base `size`. Exact for the board sizes this task draws.
  const keyOf = (boxes: number[], low: number): number => {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  };

  const statesBoxes: number[][] = [board.boxes.slice()];
  const statesPlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of board.boxes) occupied[b] = 1;
  const startLow = floodRegion(board, occupied, board.player, seen, ++stamp, stack);
  for (const b of board.boxes) occupied[b] = 0;
  index.set(keyOf(board.boxes, startLow), 0);

  let found = solved(board.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    const playerHere = statesPlayer[head]!;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    floodRegion(board, occupied, playerHere, seen, here, stack);
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (let k = 0; k < 4; k++) {
        const d = DY[k]! * w + DX[k]!;
        const dest = b + d;
        const stand = b - d;
        if (seen[stand] !== here) continue;
        if (wall[dest] || occupied[dest] || !live[dest]) continue;
        occupied[b] = 0;
        occupied[dest] = 1;
        const frozen = isFrozenBlock(board, occupied, goal, dest);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = dest;
          next.sort((x, y) => x - y);
          const low = floodRegion(board, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[dest] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move string: for each push on the path, walk to the square
  // behind the box, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes.slice();
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const dir = DY.findIndex((_, k) => DY[k]! * w + DX[k]! === to - from);
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - (DY[dir]! * w + DX[dir]!));
    for (const b of boxes) occupied[b] = 0;
    moves += PUSH[dir]!;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/**
 * Split a level into rooms: cut the hallway row's dead squares (floor the
 * player walks on where no box can ever reach a goal) out of the floor, and
 * each remaining component holding boxes is a room. Null when the level does
 * not split cleanly (a box in the hallway, or a component whose box and goal
 * counts differ).
 */
function splitRooms(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveSquares(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let x = 0; x < w; x++) {
    const i = row * w + x;
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const comp = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || comp[s] >= 0) continue;
    const id = rooms.length;
    const stack = [s];
    comp[s] = id;
    for (let i = 0; i < stack.length; i++) {
      const p = stack[i]!;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k]! * w + DX[k]!;
        if (!wall[q] && !cut[q] && comp[q] < 0) {
          comp[q] = id;
          stack.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[comp[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (comp[g] < 0) return null;
    rooms[comp[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Solve one level: room by room, whole-level search as a fallback. */
function solveLevel(text: string): string {
  const board = parseBoard(text);
  if (board.boxes.every((b) => board.goals.includes(b))) return '';
  const rooms = splitRooms(board);
  if (rooms !== null) {
    let player = board.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = board.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const sub: Board = {
        w: board.w,
        h: board.h,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const res = pushSearch(sub, MAX_ROOM_STATES);
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = endOf(board.w, player, res.moves);
      room.done = true;
    }
    if (ok) return moves;
  }
  const whole = pushSearch(board, MAX_WHOLE_STATES);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
