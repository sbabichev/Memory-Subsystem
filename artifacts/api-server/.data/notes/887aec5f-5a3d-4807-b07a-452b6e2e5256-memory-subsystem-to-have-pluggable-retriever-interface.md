---
id: 887aec5f-5a3d-4807-b07a-452b6e2e5256
type: note
title: "Memory subsystem to have pluggable retriever interface"
created: 2026-04-18T08:48:10.543Z
tags: ["architecture", "pluggable-interface", "retriever", "pgvector", "memory-subsystem"]
entities: ["concept:memory subsystem", "concept:pluggable retriever interface", "concept:architectural decision", "project:pgvector"]
---

# Memory subsystem to have pluggable retriever interface

> The memory subsystem will feature a pluggable retriever interface, allowing future integration of pgvector.

The memory subsystem is being designed with a pluggable retriever interface. This architectural decision will allow for future flexibility, specifically enabling the integration and swapping of alternative technologies like `pgvector` later on.