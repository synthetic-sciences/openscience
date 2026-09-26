---
name: framework-topology
description: "Turns a crystal structure (CIF) of a hydrogen-bonded, coordination or covalent framework into its underlying net and the quantities a topology question asks for: node definition, the periodic quotient graph, connectivity as distinct neighbours rather than bond counts, degree of interpenetration, coordination sequences and RCSR three-letter symbols, and internodal distances. Use whenever a task asks for the topology, connectivity, interpenetration or net symbol of a HOF, MOF, COF or molecular crystal from CIF or coordinate data; use atomistic-workflows for simulation setup and cheminformatics-definitions for molecular descriptors."
summary: "CIF to underlying net: nodes, distinct-neighbour edges, interpenetration, coordination sequences, RCSR symbol."
category: chemistry
allowed-tools: [Read, Write, Bash, python]
license: MIT
version: 1.0.0
author: Synthetic Sciences
metadata:
  skill-author: Synthetic Sciences
---

# Framework topology from a crystal structure

A framework's topology is a property of a graph you construct, and every wrong answer in
this area is a wrong construction: a node that should have been two, an edge counted
twice, a guest kept, a symmetry image missed, two independent nets read as one. Build the
graph explicitly, print what it is at each stage, and identify the net from the graph's own
invariants rather than from what the chemistry "usually" gives.

## Procedure

1. **Expand the structure completely.** Apply every symmetry operation to the asymmetric
   unit, merge atoms that coincide modulo the lattice (special positions), and keep the
   lattice vectors. Work in fractional coordinates with an explicit image vector per
   neighbour, so that a contact to a molecule in the next cell is a different edge from a
   contact to the same molecule in this cell.
2. **Find the molecules.** Connect atoms by covalent bonding (covalent radii plus a
   tolerance, or the CIF's bond list) across periodic boundaries; the connected components
   are the molecules. Classify each: framework former, counter-ion, or guest (solvent,
   template, anything not part of the connected framework). Guests are removed before the
   framework graph is built; say which formulas were removed and why.
3. **Define the nodes the question defines.** The default node is one framework molecule
   (its centroid); a task may instead name secondary building units, metal clusters, or
   the finite supramolecular clusters that hydrogen-bonded terminal groups form (a
   cluster of charged or acidic end groups shared by several molecules is a node in its
   own right when its members are not otherwise connected). Two-connected molecules
   are linkers, not nodes: contract them into edges before reading the net. State the node
   definition in the report; the RCSR symbol depends on it.
4. **Edges are distinct neighbours, with the question's contact criterion.** Apply the
   criterion exactly as stated (donor and acceptor element sets, D···A distance, D–H···A
   angle; or coordination bonds) at the atom level, then collapse: two molecules joined by
   any number of qualifying contacts share **one** edge. A carboxylic-acid dimer, a
   bifurcated hydrogen bond or a chelating pair is one edge. Connectivity is the number of
   distinct neighbouring nodes counting periodic images separately, never the number of
   hydrogen bonds. A molecule with four dimer partners is 4-connected, not 8-connected.
5. **Build the periodic quotient graph** (labelled quotient graph): nodes in one cell,
   edges labelled with the lattice translation between the two ends. Check its rank: the
   translations spanned by cycles must be three-dimensional for a 3-periodic net; rank 2
   is a layer, rank 1 a chain, rank 0 a finite cluster (then the node definition or the
   contact criterion is wrong for a "framework").
6. **Interpenetration.** Count the connected components of the periodic graph that are
   themselves 3-periodic: that number is the degree of interpenetration, and each
   component is analysed as its own net (they are usually identical). Components that are
   finite are guests or clusters that should already have been handled in steps 2–3. A
   single component means "not interpenetrated" (degree 1); report the degree as the
   question defines it.
7. **Identify the net.** Compute the coordination sequence of every node class (the
   number of nodes at graph distance 1, 2, …, 10 in the infinite net, counting images;
   TD10 is the running total) and the point/vertex symbol. Compare with the RCSR table for
   nets of that connectivity: `dia` (4-c: 4, 12, 24, 42, 64, …), `pcu` (6-c: 6, 18, 38,
   66, 102, …), `bcu` (8-c: 8, 26, 56, 98, 152, …), `srs`, `ths`, `qtz`, `lon`, `acs`,
   `nbo`, `cds` and so on. A coordination sequence that matches no RCSR entry means the
   graph is wrong more often than the net is new; go back to steps 3–4.
8. **Distances and averages.** An internodal distance is the centroid-to-centroid length
   of an edge, computed with the correct image vector. Report the mean over all distinct
   edges (per node class if the task asks), in the units and rounding the task states, and
   print the count of edges that entered the mean.

## Checks before reporting

- Every node's connectivity equals the number of *distinct* neighbours in the collapsed
  graph; print connectivity, number of qualifying contacts and their ratio per node class.
  A ratio of exactly 2 is the dimer trap.
- Degree, coordination sequence and RCSR symbol agree with each other (a 4-c node cannot
  be `bcu`); `dia` is not `lon` and `qtz` is not `dia` even though all are 4-c: the
  sequences separate them.
- Interpenetration degree equals the number of 3-periodic components; a stated degree of
  1 with a coordination sequence that is a multiple of a known net's is a sign that two
  nets were merged.
- Redo one framework by hand for one node: list its neighbours with image vectors and
  distances, and confirm the code's count.
- A structure that yields no framework, or a lower-periodic one, under the stated
  criterion is a construction problem before it is a chemistry one: a "framework" is one
  by definition. Check that hydrogens are present and placed (riding hydrogens may be
  absent from the file; add them at standard geometry before applying an angle
  criterion), that unwrapped or duplicated coordinates were merged modulo the lattice,
  that every symmetry operation was applied, and that the donor and acceptor sets are
  exactly the question's. Report which fix restored the framework rather than
  reinterpreting the cutoff.
- Guests removed, special positions merged, symmetry images included, the question's exact
  criterion used: say each in the report.

## Tools

`gemmi`, `pymatgen` or `ASE` read CIFs and expand symmetry; `networkx` holds the quotient
graph (use `MultiGraph` only until the collapse, then `Graph`); coordination sequences are
a breadth-first search over the periodic graph with image bookkeeping. `CrystalNets.jl`
and ToposPro are the reference implementations when available; when they are not, the
steps above reproduce their conventions.
