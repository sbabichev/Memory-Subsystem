---
id: eae4d9af-939d-483f-b27b-ad503553f112
type: insight
title: "LLM Must Not Be the Sole Memory"
created: 2026-04-18T09:21:50.429Z
tags: ["llm-architecture", "memory-management", "archivist", "system-design", "ai-agents"]
entities: ["concept:Large Language Model", "concept:Archivist"]
---

# LLM Must Not Be the Sole Memory

> LLMs should not inherently serve as the memory; a separate, external memory managed by an Archivist is proposed.

A core architectural principle is that the Large Language Model (LLM) itself should not function as the sole or primary memory. Instead, memory needs to be stored separately and handled by an "Archivist" component, acting as an external layer.