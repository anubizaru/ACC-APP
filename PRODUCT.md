# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

static HTML/CSS + Vue 3 in the browser, with Google Apps Script as the authenticated backend and Google Sheets as the data store. The repository also contains a Cloudflare Worker template, but the active product flow is the Google Sheets deployment described in the app instructions.

## Users

Primary users are shop owners and administrative staff operating a pawnshop or collateral lending business. They need to manage products, customer debt records, accounting entries, and due-date tracking in a single operational workflow.

## Product Purpose

This product helps a pawnshop manage its lending operations: registering pledged goods, calculating interest and maturity dates, tracking cash inflows/outflows, reconciling accounting entries, and reviewing summaries and reports. Success means the shop can record each transaction accurately, monitor outstanding obligations, and maintain a clear operational ledger without a separate accounting system.

## Positioning

The product is a purpose-built pawnshop accounting workflow, not a general ledger or ecommerce platform. Its differentiator is the combination of item-based collateral tracking, interest rules, repayment schedules, creditor and accounting views, and the direct Google Sheets backend used by a small business operator.

## Operating Context

The app is used in a Thai-language business setting by operators who connect the web UI to a deployed Google Apps Script web app. Product records, transactions, and accounting data are stored in Google Sheets. Staff work through dashboard, product, accounting, creditors, reports, settings, and guide views; the app supports a demo mode for exploration and a real mode for connected production data.

## Capabilities and Constraints

Confirmed capabilities include:

- product registration and categorization for pawned goods
- interest and maturity-date calculation rules
- due-date scheduling and repayment tracking
- accounting records with income, pay, and profit logic
- creditor/account records and related summaries
- dashboard and reporting views for operational health
- login/authentication for admin access
- demo mode and real backend connection flow

Confirmed constraints and product facts:

- the app is designed for a small business, not a multi-tenant SaaS platform
- values are validated as integer baht amounts in the business logic
- a deployed Google Apps Script web app is the primary live backend path
- the app uses a Thai-language interface and product terminology
- the stack is intentionally lightweight and code-first rather than framework-heavy

## Brand Commitments

The product uses a Thai-language operational identity and presents itself as a pawnshop accounting system. Existing naming, labels, and interface language in the implementation are the current brand authority; no separate external brand system or identity guidelines are documented in the repository.

## Evidence on Hand

- [Code.gs](Code.gs): Google Apps Script backend, setup flow, authentication, and storage model
- [index.html](index.html): web app shell and Thai-language product metadata
- [js/app.js](js/app.js): Vue application, route structure, demo vs real backend behavior, and operational workflows
- [test-backend.js](test-backend.js): confirms the product behavior for login, setup, product and accounting actions, and due-date logic
- [js/logic.js](js/logic.js): financial and interest rules for the pawnshop domain

## Product Principles

1. Operational trust matters more than abstraction; the system must make transaction math and accounting logic auditable.
2. Small-business workflows should be simple, direct, and task-focused instead of generic enterprise complexity.
3. Core financial rules must be explicit, repeatable, and protected by validation and tests.
4. The product should support both guided demo exploration and real production use without changing the user model.
5. The user experience should remain grounded in the shop operator's daily routines, not in a generalized consumer app pattern.

## Accessibility & Inclusion

No product-specific accessibility requirement or inclusion policy is documented in the repository beyond the need for a usable, browser-based interface. The app should preserve standard web accessibility expectations, including keyboard access and clear readable UI, as future work proceeds.
