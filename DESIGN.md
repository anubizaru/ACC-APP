# Design system

## Direction

**ปฏิทินหน้าร้าน (Shop Calendar)** gives shop staff a clear view of pledge maturities and a short path from follow-up to interest payment or redemption. The dashboard leads with today's work, principal balances, a selectable seven-day due-date strip, and the records that need attention.

The interface keeps the previous UI's olive-green, charcoal, and light neutral palette, with its familiar green, red, and blue status colors. The calendar-driven layout adds clearer task hierarchy without replacing the app's established color identity. It relies on Thai text, familiar web controls, and real shop records rather than decorative imagery or invented metrics.

## Foundations

### Color

| Role | Token | Value |
|---|---|---|
| Page background | `--color-bg` | `#f3f5ef` |
| Quiet surface | `--color-surface` | `#fafbf8` |
| Card surface | `--color-surface-2` | `#ffffff` |
| Secondary surface | `--color-surface-offset` | `#edf0e7` |
| Divider | `--color-divider` | `#dfe4d8` |
| Border | `--color-border` | `#cdd5c4` |
| Text | `--color-text` | `#292c25` |
| Muted text | `--color-text-muted` | `#6b7165` |
| Primary | `--color-primary` | `#5a7828` |
| Navigation | `--color-nav` | `#292b28` |
| Accent | `--color-gold` | `#96933a` |
| Success | `--color-success` | `#3d7743` |
| Warning | `--color-warning` | `#9a6b0f` |
| Overdue / danger | `--color-danger` | `#a63a3a` |
| Information | `--color-info` | `#2a5f8a` |

Status colors are paired with readable text labels; color is not the only status cue.

### Typography

- Use Anuphan first, with Segoe UI, Noto Sans Thai, and sans-serif fallbacks.
- Base text is 16px. The shared scale is 13px, 15px, 16px, 19px, and 26px.
- Use tabular numerals for money, counts, dates, and other aligned financial values.
- Keep supporting text muted but legible; reserve smaller text for secondary metadata.

### Spacing and shape

- Use the 4px spacing rhythm defined by `--space-1` through `--space-16`.
- Use compact 5–7px control corners and 10–14px card/dialog corners.
- Keep shadows subtle on everyday surfaces; use a stronger shadow only for overlays.
- Use the shared 180ms transition and honor `prefers-reduced-motion`.

## Layout and components

- At 900px and wider, use a 228px fixed navigation rail and flexible content.
- Below 900px, replace the rail with the compact top bar and bottom navigation.
- At 640px and below, stack dashboard balances, scroll the seven-day strip horizontally, and present dialogs as scrollable bottom sheets.
- Keep the dashboard's action order: search and new pledge, principal summary, due-date strip, follow-up list.
- Selecting a calendar day filters the follow-up list; selecting a record opens its existing product details and transaction actions.
- Product rows keep customer and item details readable on mobile, with history, status, and delete controls arranged below rather than compressing the primary text.
- Reuse the shared card, button, chip, input, badge, table, dialog, receipt, and snackbar styles across every route.

## Accessibility

- Preserve visible keyboard focus and the reduced-motion preference.
- Mark the current navigation item and selected calendar date for assistive technology.
- Expose loading and snackbar feedback through live regions; label modal dialogs and mark them modal.
- Give calendar dates and record actions descriptive accessible names.
- Keep compact-screen navigation and dialogs usable without horizontal page overflow.

## Implementation and constraints

The design is implemented in `css/styles.css` and existing Vue templates in `js/app.js`. It does not add a UI dependency or alter business calculations, validation, routes, authentication, data models, or Google Sheets / Cloudflare connection behavior. The approved composition reference is [the Shop Calendar sketch](./.impeccable/mocks/decision/shop-calendar.html); the app-wide requirements are recorded in [the surface brief](./.impeccable/surfaces/index-html.md).
