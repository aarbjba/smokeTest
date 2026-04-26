# A Philosophy of Software Design

## Purpose

This repository follows **A Philosophy of Software Design** in the sense of John Ousterhout:
fight complexity directly by designing modules with deep value, clean interfaces, strong information hiding, and low cognitive load.

All code generation, edits, and reviews must optimize for:
- lower complexity
- deeper modules
- simpler interfaces
- stronger information hiding
- fewer special cases
- clear separation between interface and implementation
- strategic design over tactical patching

This file is a binding engineering policy for Claude.

---

## Primary Directive

Complexity is anything that makes software hard to understand or hard to change.

When uncertain, choose the design that:
1. reduces the number of things a reader must know at once
2. hides more details behind a stable interface
3. eliminates exceptions and awkward cases
4. creates a deeper module instead of a shallower one
5. lowers future cognitive load, not just present typing effort

Do not optimize for shorter files, fewer lines, or clever compactness if complexity rises.

---

## Core Complexity Rules

### Symptoms of Complexity
Treat these as architectural warnings:
- change amplification
- cognitive load
- unknown unknowns
- hidden dependencies
- information spread across many places
- temporal coupling that readers must reconstruct mentally

### Default Response
When a feature feels awkward, first ask:
- is the interface too wide?
- is the behavior scattered?
- are details leaking that should be hidden?
- are there too many special cases?
- are we solving a tactical local problem while increasing global complexity?

---

## Module Depth Rules

### Prefer Deep Modules
A deep module offers a simple interface but hides substantial complexity behind it.

Rules:
1. Design modules to hide meaningful internal complexity.
2. Prefer a small interface with strong semantics over a large surface with minor helpers.
3. Make each module carry its own weight.
4. A module that only forwards work is usually too shallow.

### Avoid Shallow Modules
Shallow modules are bad when:
- the interface exposes almost as much complexity as the implementation
- layers exist mostly to redirect calls
- small wrappers multiply concepts without reducing reader burden

Anti-patterns:
- pass-through service classes
- thin wrappers around libraries with no simplification
- helper modules that only rename obvious operations

---

## Information Hiding Rules

1. Hide design decisions that are likely to change.
2. Hide internal data representations.
3. Hide incidental workflow steps and bookkeeping.
4. Keep callers from depending on implementation detail, performance hacks, or storage shape.
5. Encapsulate messy edge conditions and normalization logic.

Anti-patterns:
- exposing internal collections for direct mutation
- leaking SQL, HTTP, framework, or file-format details through domain APIs
- callers coordinating object internals across multiple modules

---

## Interface Design Rules

1. Design interfaces around what clients need to know, not how the implementation works.
2. Keep interfaces narrow but meaningful.
3. Avoid APIs that require callers to stage operations in fragile sequences.
4. Eliminate arguments that only exist to expose internal implementation choices.
5. Use names and method shapes that reveal the abstraction, not the mechanism.

Good interface signs:
- few methods
- strong semantic guarantees
- limited required context
- callers do not need to understand internals

Bad interface signs:
- many configuration flags
- call-order traps
- multiple setup methods required before use
- booleans and mode parameters switching internal behavior

---

## Strategic Programming over Tactical Programming

### Strategic Programming
1. Spend time reducing future complexity, not only making the current change pass.
2. Reshape abstractions when recurring friction appears.
3. Invest in interfaces and decomposition that make future changes local.
4. Leave behind clearer structure after every substantial edit.

### Tactical Programming
Avoid:
- patching local symptoms while increasing global complexity
- copy/paste to meet a deadline
- exposing one more internal detail instead of designing a better boundary
- adding flags and exceptions to avoid a better abstraction

---

## General-Purpose vs Special-Purpose Modules

1. Prefer modules that capture a reusable concept at the right abstraction level.
2. Do not overfit interfaces to one narrow caller if a slightly more general concept is obvious.
3. Do not generalize so far that the abstraction becomes vague.
4. The best module is specific enough to be strong and general enough to be reusable within its domain.

---

## Error Handling and Exception Elimination

1. Define APIs that make misuse hard.
2. Define away invalid states and awkward cases where possible.
3. Eliminate exception cases by changing the interface or invariant, not only by adding more checks.
4. Use special/general decomposition when unusual cases clutter the main abstraction.
5. Keep the normal path obvious and the exceptional path isolated.

Anti-patterns:
- APIs that require every caller to repeat defensive ceremony
- “special case” branches scattered across many call sites
- exposing half-valid objects and asking callers to tiptoe around them

---

## Pull Complexity Downward

1. Put complexity in one place rather than many.
2. Hide intricate logic behind a simpler public contract.
3. Prefer a slightly more complex implementation if it makes all callers simpler.
4. Remove repeated reasoning burdens from call sites.

This is the opposite of pushing complexity outward through flags, setup steps, and coupled operations.

---

## Comment Rules

Comments must reduce complexity, not narrate obvious code.

Use comments for:
- interface contracts
- non-obvious invariants
- hidden design decisions
- the reason an abstraction exists
- tricky implementation facts callers do not need to know

Do not use comments to compensate for:
- bad naming
- poor decomposition
- confusing control flow
- missing abstraction

---

## Function and Variable Rules

1. Keep functions deep enough to hide a meaningful amount of work.
2. Avoid long functions only when they create cognitive load, not as a numeric ritual.
3. Avoid pass-through variables that do not add meaning.
4. Use variables to capture meaning, not to mirror syntax.
5. Keep local details local.

Anti-patterns:
- chains of tiny functions where readers must jump constantly to understand one idea
- variables introduced only to satisfy style rather than clarity
- exposing intermediate states that should stay internal

---

## Temporal Decomposition Rules

1. Do not structure modules primarily around execution order if the real structure is conceptual.
2. Prefer decomposition around stable concepts and responsibilities.
3. Initialization steps, processing phases, and cleanup stages should not force readers to reconstruct the design from time-order alone.
4. Keep call ordering simple and explicit where it matters.

Anti-patterns:
- `prepare/process/finalize` everywhere without domain concepts
- APIs that require secret temporal knowledge
- partial objects whose meaning depends on which phase has already run

---

## Special-General Decomposition

Use special-general decomposition when a small number of exceptions are cluttering the main logic.

Rules:
1. Keep the general case simple.
2. Isolate the unusual or rare behavior.
3. Do not pollute the main abstraction with every edge case.

This is preferable to accreting conditionals into the core path forever.

---

## Review Rules for Claude

When reviewing code, actively look for:
- shallow modules
- pass-through layers
- interfaces that expose implementation detail
- excessive flags or mode parameters
- scattered special cases
- cognitive load caused by too many interacting modules
- hidden temporal constraints
- complexity pushed to callers
- comments that explain what should be encoded in structure
- tactical patches that increase future difficulty

---

## Forbidden Patterns

### Shallow Decomposition
- splitting code into many tiny units that do not reduce understanding cost
- wrappers and facades that add names but not simplification

### Interface Leakage
- APIs that expose storage, transport, or caching mechanics to ordinary callers
- method sequences that require callers to know internal workflow

### Tactical Complexity Debt
- adding one more flag, callback, or conditional instead of improving the abstraction
- fixing the local symptom while making the design harder overall

### Complexity Spread
- repeating the same special handling in many places
- making all callers responsible for one module's awkwardness

---

## Code Generation Rules

When generating code, default to:
1. identify the concept that deserves a module boundary
2. design the narrowest strong interface around that concept
3. hide volatile or complicated details inside
4. simplify all callers, even if implementation grows slightly
5. isolate special cases
6. reduce the number of facts a reader must juggle at once

Avoid by default:
- pass-through layers
- needless tiny abstractions
- exposing internal data formats
- temporal APIs with fragile call sequences
- multiplying concepts without reducing complexity

---

## Testing Rules

1. Test public behavior and interface contracts.
2. Test hidden complexity through stable public APIs where possible.
3. Add focused tests around isolated special cases.
4. Avoid tests that force callers to know implementation detail if the abstraction promises otherwise.

---

## Review Checklist

Before finalizing any change, verify:
- Did this change reduce or increase cognitive load?
- Is the module deeper or shallower after the edit?
- Did we hide more complexity behind a stable interface?
- Did we reduce special-case handling at call sites?
- Did we remove an implementation detail from the public surface?
- Did we avoid a pass-through layer?
- Does the interface describe the abstraction rather than the mechanism?
- Did we improve future changeability, not just present convenience?

If any answer is no, revise before shipping.

---

## Final Instruction

When uncertain, choose the design that:
1. creates a deeper module
2. hides more complexity
3. reduces special cases
4. lowers cognitive load for callers
5. improves the abstraction instead of patching around it

Fight complexity directly.
