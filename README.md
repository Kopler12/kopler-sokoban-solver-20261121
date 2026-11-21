[![make.fun](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun)

# Sokoban Solver

A push-optimal Sokoban solver for the make.fun bounty
`sokoban-solver-01-run-20261121`.

## How it works

A level is a hallway with small rooms off it, and a box pushed out of its
room can never come back — so each room is solved on its own and the push
counts add up. Inside one room the solver runs a breadth-first search over
pushes (not steps): a state is the sorted box squares plus the player's
reachable region, named by its lowest square. The first solved state the
queue reaches is therefore push-optimal for that room.

Deadlock pruning, all of it safe (it never removes a solvable state):

- **Live squares** — a box can only sit where it could be pulled back from
  a goal, ignoring the other boxes. This also covers corners and wall
  segments with no goal on them.
- **Frozen 2x2 blocks** — four wall-or-box squares holding a box off a goal.

Rooms are found by cutting the hallway row's dead squares out of the floor
and taking each remaining component that holds boxes. If a level does not
split cleanly, the solver falls back to a whole-level push search.

The search is bounded by a fixed number of states, never by the wall
clock, so two runs always write the same bytes.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` needs nothing but Node 22 — no dependencies, no network.
