# Pawnshop operations interface

## Scope and mode

Full web application redesign across welcome and connection, login, dashboard, product list and details, accounting, creditors, reports, settings, and setup guide. Mode: Operate.

## Audience and task

Thai shop owners and staff need to find active pledge records, understand which payments are due or overdue, and quickly complete a new pledge, interest payment, or redemption without losing the financial context.

## Evidence and constraints

Use the app's actual customer, product, amount, maturity, and transaction data. Preserve every existing route, capability, validation rule, authentication flow, backend integration, data model, and Thai business term. Keep the lightweight Vue/static web stack and make navigation, tables, forms, dialogs, loading, errors, empty states, and mobile layouts consistently accessible and usable.

## Direction contract

THESIS: Make every pledge's due date visible and actionable; refuse the generic dashboard where equal-weight cards bury the next task.

OWN-WORLD: Keep the established UI palette: olive-green primary and active navigation, charcoal shell, pale green-gray surfaces, and the familiar green, red, and blue status colors. Use one highly legible Thai sans with tabular financial numerals, steady alignment, and standard web controls. The signature is a compact seven-day maturity strip that anchors due dates and scopes the follow-up list.

STORY: The operator first understands today's urgent work, then selects the relevant pledge and continues to interest payment or redemption while keeping its status and principal visible.

FIRST VIEWPORT: On desktop, keep the standard section navigation in a left rail. The main area opens with today's date, a clear page title, search, and the primary “รับสินค้าใหม่” action; follow with three summary measures, a seven-day due strip, then a readable follow-up table with record number, customer, item, due status, and principal. On mobile, collapse navigation without obscuring the task list and allow the date strip to scroll horizontally.

FORM: Thai pocket and shop-wall calendar, seventh of seven grounded directions; assigned by the roll. seed:67719c9471dcb3d2.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Open decisions

Keep the current date display and terminology; do not introduce new financial metrics, product claims, or imagery without confirmed data and assets.
