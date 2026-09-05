# Use SWE-bench Full as the First Benchmark

**Status:** accepted

AutoData will use a pinned SWE-bench Full profile as its first benchmark because Full provides an official development split for repeated evolution feedback and a distinct test split for final reporting, whereas Verified has no official development split. The first protocol uses Full dev for search, keeps Full test sealed, and does not add a separate promotion-validation split; the TaskRunner remains replaceable and initially uses mini-SWE-agent.
