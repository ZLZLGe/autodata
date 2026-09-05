# AutoData

AutoData is a data-evolution system that improves the training value of agent trajectories through iterative curation and evaluation. This file defines domain language only; design decisions belong in [docs/design-interview.md](./docs/design-interview.md).

## Trajectory data

**Main trajectory**:
The top-level agent interaction that supplies the primary learning content of a source trajectory.
_Avoid_: parent trace

**Sub-agent trajectory**:
A delegated interaction nested within a main trajectory rather than an independent training record.
_Avoid_: standalone trajectory

**ms-swift trajectory**:
A trajectory expressed in ms-swift's conversational training format at AutoData's dataset boundary.
_Avoid_: raw gateway trace

**Canonical trajectory**:
The normalized main-trajectory training content that AutoData uniquely identifies and treats as its reusable curation unit. Its domain representation is a **canonical record**.
_Avoid_: source row, training view entry, exported training row

**Record ID**:
A versioned, content-derived identity for a canonical trajectory, stable across source occurrences, data strategies, and training views.
_Avoid_: upstream ID, source path, row number, training-view position

**Rejected input row**:
A dataset-boundary JSONL row that cannot become a canonical trajectory during import or normalization.
_Avoid_: quarantine, filtered-out record

**Filtered-out record**:
A valid canonical record omitted from a particular training view by a data strategy while remaining part of its input snapshot.
_Avoid_: rejected input row, invalid input

**Input snapshot**:
A fixed collection of canonical records that forms the closed universe for a set of comparable data strategies.
_Avoid_: training view, candidate output

**Closed-set curation**:
A mode in which a data strategy derives training material only from canonical trajectories already present in an input snapshot, without creating semantically new trajectories.
_Avoid_: rollout generation, synthetic data generation

**Data strategy**:
A versioned curation policy that selects and organizes canonical records into a training view.
_Avoid_: model prompt, benchmark policy

**Training view**:
An ordered selection of canonical records from an input snapshot prepared for one training use.
_Avoid_: input snapshot, benchmark result

**Training view entry**:
A view-specific reference that places one canonical record in a training view. It is not a copy or a new semantic trajectory.
_Avoid_: canonical record, duplicated trajectory

**Training exposure**:
One occasion on which the Trainer consumes the content referenced by a training view entry. Re-exposure in a later training pass does not create another entry or change training-view uniqueness.
_Avoid_: duplicate training view entry, repeat factor

**Trajectory training view**:
The training view used to train a candidate model, distinct from every benchmark task split.
_Avoid_: benchmark training set, raw trajectory pool

**Trajectory facet**:
A named, deterministic characteristic derived from canonical trajectory content, such as tool-use profile, turn count, or length band. A source/provenance locator is not a trajectory facet.
_Avoid_: benchmark label

**Bucket**:
An interpretable, possibly overlapping group defined from one or more trajectory facets. Buckets describe training-view composition and are not benchmark splits or mutually exclusive class labels.
_Avoid_: benchmark split, exclusive trajectory type

**Selection score**:
A data-strategy-derived value recorded on a training view entry to rank its referenced canonical trajectory when selection is bounded. It is view-specific selection metadata, not an immutable cleaning fact of the canonical trajectory.
_Avoid_: bucket weight, canonical quality score

**Bucket weight**:
A relative mixing preference attached to a bucket when selecting a bounded training view. It guides representation between groups but neither scores an individual trajectory nor guarantees a bucket count.
_Avoid_: weight, selection score, quality score

**Training view maximum records**:
An optional upper bound on the number of unique entries in a training view. It limits an oversized selection but does not imply that a smaller selection must be filled.
_Avoid_: target count, minimum dataset size

**Bucket maximum quota**:
An optional upper bound on the number of selected entries belonging to a bucket. It prevents one group from occupying too much of a bounded training view and does not require scarce records to be repeated.
_Avoid_: minimum quota, target count, benchmark budget

## Evolution

**Evolution loop**:
The feedback process that uses trained-model behavior and benchmark evidence to diagnose and revise AutoData's data strategy over time.
_Avoid_: model training alone, agent conversation

**Generation**:
A numbered lineage level for the baseline and its successor candidate harnesses; generation 0 is the baseline, and candidates proposed from it belong to generation 1.
_Avoid_: evolution round, checkpoint number

**Evolution round**:
One cycle that starts from the current champion and considers one or more successor candidates. A round can evaluate several candidates or leave the champion unchanged, so its count is not a generation identifier.
_Avoid_: generation, candidate attempt

**Diagnosis Agent**:
The advisory role that explains prior candidate outcomes and trajectory evidence to guide the next evolution round; it does not control retries or promotion.
_Avoid_: benchmark evaluator, Generator Agent, control plane

**Generator Agent**:
The creative role that proposes a new candidate data strategy or harness revision from a diagnosis and the current champion context.
_Avoid_: Diagnosis Agent, Strategy Agent, retry controller

**Candidate harness**:
A versioned AutoData alternative evaluated as a possible successor to the current champion; it embodies a data strategy.
_Avoid_: prompt-only suggestion, model checkpoint

**Candidate proposal**:
The Generator Agent's description of a prospective candidate harness before it becomes an evaluable candidate snapshot.
_Avoid_: candidate snapshot, accepted candidate

**Candidate snapshot**:
The complete executable representation of a candidate harness at a particular point in its lineage.
_Avoid_: candidate proposal, patch alone

**Population**:
The candidate harnesses considered together in one evolution round.
_Avoid_: model batch, archive

**Champion**:
The selected candidate harness that serves as the parent and reference for the next evolution round.
_Avoid_: newest candidate, latest checkpoint

**Archive**:
The historical collection of candidate attempts and their evidence, including candidates that did not become champion.
_Avoid_: active population

**Host**:
The trusted AutoData control-plane role that classifies outcomes, enforces the candidate lifecycle, and owns retry and promotion decisions.
_Avoid_: Diagnosis Agent, Generator Agent

## Benchmark evidence

**Task runner**:
The benchmark-facing participant through which a trained model attempts a task and produces an interaction trajectory for evaluation.
_Avoid_: benchmark evaluator, score parser

**Evaluation artifact**:
The evidence produced by evaluating a candidate, including the observed behavior and outcome needed for diagnosis and comparison.
_Avoid_: score alone, training view

**Resolved count**:
The number of benchmark cases satisfying a benchmark profile's resolved criterion in one complete evaluation.
_Avoid_: composite score, category score, pass rate

**SWE-bench profile**:
A named definition of a SWE-bench task corpus and its scoring interpretation for an AutoData evolution run.
_Avoid_: unnamed benchmark choice

**SWE-bench Full**:
The SWE-bench profile covering the full benchmark corpus rather than a curated subset such as SWE-bench Verified.
_Avoid_: default SWE-bench, unqualified SWE-bench

**Search split**:
The benchmark cases used repeatedly to diagnose and compare candidates during an evolution run.
_Avoid_: trajectory training view, sealed test split

**Sealed test split**:
The benchmark cases withheld from the evolution loop and reserved for final assessment.
_Avoid_: search split, promotion set
