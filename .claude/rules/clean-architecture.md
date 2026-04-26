# Clean Architecture

## Purpose

This repository must follow **Clean Architecture**.
When writing, modifying, or reviewing code, prefer decisions that preserve:
- independent business rules
- inward-pointing dependencies
- framework independence
- database independence
- UI independence
- testability
- replaceable details

Treat this file as a binding implementation policy.

---

## Non-Negotiable Rules

1. **Follow the Dependency Rule**
   - Source code dependencies must point inward, toward higher-level policies.
   - Inner layers must not import or depend on outer layers.
   - Business rules must not depend on frameworks, web handlers, ORMs, database drivers, UI libraries, SDKs, queues, or vendor APIs.

2. **Keep Business Rules Pure**
   - Entities and use cases must contain business policy.
   - Business rules must not read HTTP requests, environment variables, framework context, ORM models, or raw SQL rows directly.
   - Pass plain data into use cases through request models or arguments.

3. **Treat Frameworks as Details**
   - Frameworks are tools, not the foundation of the design.
   - Keep framework annotations, decorators, controllers, routes, middleware, serializers, and ORM artifacts at the edges.
   - Do not let framework types leak into core policies.

4. **Treat the Database as a Detail**
   - Do not shape the domain model around tables.
   - Use repositories or gateways to isolate persistence.
   - Business rules must work without a real database.

5. **Treat the Web as a Detail**
   - Controllers and endpoints translate HTTP into input models for use cases.
   - Use cases must not know about HTTP, JSON transport, status codes, cookies, headers, or routing.
   - Presenters or response mappers translate use case output for delivery mechanisms.

6. **Use Explicit Boundaries**
   - Define interfaces at architectural seams.
   - External systems, persistence, messaging, file systems, clocks, and vendor SDKs must sit behind boundaries.
   - Prefer adapters over direct calls from policy code to implementation details.

7. **Organize by Use Case**
   - Prefer feature and use-case oriented structure over generic technical buckets.
   - The architecture should scream the domain and application intent.
   - Avoid codebases dominated by folders like `utils`, `helpers`, `common`, `services`, or `misc`.

8. **Use Cases Must Orchestrate**
   - A use case coordinates entities, repositories, and gateways.
   - A use case should not contain delivery concerns, ORM concerns, or presentation formatting concerns.
   - A use case should represent one application action.

9. **Entities Must Guard Invariants**
   - Critical domain rules belong in entities or equivalent domain objects.
   - Entities must protect invariants and consistency.
   - Do not leave core rules in controllers, jobs, handlers, or SQL scripts.

10. **Outer Layers May Depend on Inner Layers, Never the Reverse**
    - Controllers may depend on use cases.
    - Repositories may implement interfaces defined by the use case or domain layer.
    - Presenters may implement output boundaries owned by inner layers.
    - Never invert this relationship accidentally.

---

## Required Layer Responsibilities

### Domain Layer
Contains:
- entities
- value objects
- domain services only if truly necessary
- domain invariants
- core business rules

Must:
- be framework free
- be persistence ignorant
- be delivery mechanism agnostic
- avoid annotations and infrastructure imports where possible

Must not:
- import web libraries
- import ORM types
- import SDK clients
- perform I/O
- read configuration directly

### Application Layer
Contains:
- use cases
- input models
- output models
- ports and boundaries
- orchestration logic

Must:
- depend on domain abstractions and models
- define interfaces for required external behavior
- coordinate workflows explicitly

Must not:
- contain controller logic
- contain SQL
- return framework response types
- format UI strings unless explicitly part of a presenter boundary

### Interface Adapters Layer
Contains:
- controllers
- presenters
- view models
- repository implementations
- gateway adapters
- mappers between external and internal models

Must:
- translate between external formats and internal models
- depend inward on application and domain code
- isolate framework and vendor details

Must not:
- move business policy out of the use case or domain layer
- bypass use cases to call repositories directly unless explicitly justified by architecture

### Infrastructure Layer
Contains:
- framework bootstrap
- dependency injection wiring
- database access details
- SDK integrations
- message bus clients
- filesystem implementations
- network clients

Must:
- remain replaceable
- implement interfaces owned by inner layers
- stay at the outermost edge

Must not:
- define business rules
- dictate domain shapes
- leak vendor types inward

---

## Code Generation Rules

When generating code, always apply the following.

### 1. Define the Use Case First
For every non-trivial feature:
- identify the use case
- define the input
- define the output
- define required ports
- keep orchestration in one place

Prefer this order:
1. domain rule or entity behavior
2. use case
3. boundary interfaces
4. presenter contract
5. repository or gateway contract
6. adapters
7. framework wiring

### 2. Use Plain Models at Boundaries
- Use request and response models owned by the application layer.
- Do not pass ORM entities, HTTP requests, or framework DTOs into core logic.
- Do not return framework objects from use cases.

### 3. Create Ports for Volatile Dependencies
Introduce interfaces for:
- repositories
- gateways
- mailers
- payment providers
- message publishers
- storage providers
- clocks
- ID generators
- transaction runners if needed

Do not call volatile details directly from core use cases.

### 4. Keep Wiring in the Main Component
- Object construction belongs in the composition root.
- Do not instantiate infrastructure dependencies inside use cases or entities.
- Use dependency injection, explicit factories, or composition in the outer layer.

### 5. Prefer Stable Dependencies
- Inner layers own the abstractions they need.
- Outer layers implement those abstractions.
- Avoid shared "common" packages that create sideways coupling.

### 6. Keep Boundaries Visible
- When in doubt, introduce a boundary sooner.
- Partial boundaries are acceptable if they preserve future extraction options.
- Use interfaces, request models, and output models to avoid coupling to details.

---

## Architecture Heuristics

### Dependency Direction
Always verify:
- Does this import point inward?
- Is a high-level policy depending on a low-level detail?
- Is a framework or vendor type leaking into a core layer?
- Is an adapter bypassing the intended boundary?

If yes, refactor.

### Policy vs Detail
When placing code, ask:
- Is this business policy?
- Is this orchestration?
- Is this translation?
- Is this infrastructure?

Put the code in the highest-level place that matches its responsibility.

### Stable Core, Replaceable Edge
Prefer designs where you can replace:
- web framework
- persistence technology
- message broker
- job runner
- cloud vendor
- serializer
- UI
without rewriting business rules.

### Feature First Structure
Prefer:
- `orders/place_order`
- `orders/cancel_order`
- `billing/pay_invoice`
- `users/register_user`

Over:
- `controllers`
- `services`
- `repositories`
- `utils`

Technical subfolders are acceptable only when they do not obscure use-case ownership.

---

## Naming Rules

- Name modules and packages after business capabilities or use cases.
- Name use cases with verbs: `PlaceOrder`, `RegisterUser`, `WithdrawFunds`.
- Name ports by role: `OrderRepository`, `PaymentGateway`, `Clock`, `UserPresenter`.
- Name adapters by detail: `SqlOrderRepository`, `StripePaymentGateway`, `HttpUserController`.
- Avoid vague names such as `Manager`, `Processor`, `Service`, `Helper`, `Util`, `Common`.
- If a class is named `Service`, justify why it is not a use case, adapter, or domain object.

---

## Testing Rules

### Core Tests First
Prioritize tests for:
- entities
- value objects
- use cases
- boundary contracts

These tests must:
- run without the real framework
- run without the real database
- run without the network
- run fast and deterministically

### Adapter Tests
Test adapters separately for:
- mapping correctness
- repository behavior
- controller translation
- presenter formatting
- integration with framework or SDK

Do not use slow integration tests as a substitute for testing business rules.

### Test Through Supported Boundaries
- Avoid reaching private internals when a public use case boundary exists.
- Prefer testing use cases with fakes or mocks for ports.
- Use integration tests only where architectural seams meet real details.

---

## Forbidden Patterns

Do not generate or keep code that does any of the following unless explicitly required and justified.

### Framework Leakage
- domain entities annotated with ORM or web framework metadata when avoidable
- use cases depending on `Request`, `Response`, `HttpContext`, controller base classes, framework sessions, or middleware objects
- application layer importing serializer or ORM base classes

### Database Leakage
- use cases returning table rows or ORM entities
- domain rules embedded in repository implementations or SQL
- domain objects designed primarily around persistence convenience

### Controller-Centric Logic
- controllers containing branching business rules
- controllers performing validation that belongs to business policy
- controllers calling repositories directly instead of use cases

### God Services
- large `*Service` classes that create, fetch, validate, persist, publish, and present everything
- services that own unrelated use cases
- application services that become dumping grounds

### Layer Bypass
- controllers bypassing use cases to call repositories
- presenters reading directly from databases
- infrastructure code importing inward and also being imported by domain code

### Direction Violations
- repository interfaces defined in infrastructure and consumed by core policy
- entities importing adapters
- use cases depending on concrete implementations

### Utility Dumping Grounds
- `utils`, `helpers`, `shared`, `common`, `base`, `core` used as architecture escape hatches
- generic abstractions with no clear ownership
- convenience modules that hide bad dependency direction

---

## Refactoring Rules

When modifying existing code:

1. **Move business rules inward**
   - Extract domain logic from controllers, handlers, views, repository classes, and jobs.

2. **Introduce boundaries around details**
   - Wrap external SDKs, database access, message buses, filesystem operations, and clocks.

3. **Replace concrete dependencies with ports**
   - Define interfaces in inner layers.
   - Implement them in outer layers.

4. **Separate translation from policy**
   - Request parsing, DTO mapping, serialization, and presentation formatting belong outside core business rules.

5. **Break up god services**
   - Split by use case.
   - Give each use case one clear application action.

6. **Eliminate framework coupling from tests**
   - Rewrite tests to target use cases and entities directly where possible.

7. **Preserve behavior while improving direction**
   - Refactor incrementally.
   - Prefer safe boundary extraction over large rewrites.

---

## Output Expectations for Claude

When asked to implement a feature, default to producing:
- a domain model or entity if business invariants exist
- a focused use case
- input and output models if needed
- ports/interfaces for external dependencies
- adapters for web, persistence, or messaging details
- composition root wiring outside the use case

When asked to modify existing code:
- keep or improve dependency direction
- avoid adding framework dependencies to inner layers
- call out architectural debt explicitly if it cannot be fixed safely now

When asked to review code:
- identify boundary violations
- identify dependency rule violations
- identify framework leakage
- identify misplaced business rules
- identify god services and layer bypass
- propose concrete refactorings toward Clean Architecture

---

## Review Checklist

Before finalizing any change, verify:

- Are business rules independent from frameworks?
- Are use cases independent from delivery and persistence details?
- Do source dependencies point inward?
- Are controllers thin?
- Are repositories just persistence adapters?
- Are entities guarding domain invariants?
- Are ports owned by inner layers?
- Is composition happening at the edge?
- Can core tests run without the web framework and database?
- Does the project structure reflect the domain and use cases?
- Did we avoid `utils`/`helpers` dumping grounds?
- Did we avoid creating another god service?
- Did we keep details replaceable?

If any answer is no, revise the design before shipping.

---

## Preferred Default Shapes

### Preferred feature shape
- `domain/`
- `application/`
- `adapters/`
- `infrastructure/`

Or, if feature-oriented:
- `orders/domain/`
- `orders/application/`
- `orders/adapters/`
- `orders/infrastructure/`

### Preferred use case shape
- `command` or request model
- `use case`
- `output boundary` or response model
- `ports`
- adapter implementations outside

### Preferred dependency pattern
- inner layer defines interface
- outer layer implements interface
- composition root wires them together

---

## When Tradeoffs Are Necessary

If constraints force a compromise:
- keep the compromise at the outermost layer possible
- document the boundary violation clearly in code comments or review notes
- avoid normalizing the compromise into the core architecture
- preserve a future path to separation

Choose the design that minimizes long-term coupling, not the one that is only shortest today.

---

## Final Instruction

When uncertain, choose the option that:
1. keeps business rules independent
2. points dependencies inward
3. isolates details behind boundaries
4. improves testability
5. makes replacement of frameworks, databases, and delivery mechanisms easier

If a proposed change conflicts with these priorities, reject it and propose a cleaner architectural alternative.
