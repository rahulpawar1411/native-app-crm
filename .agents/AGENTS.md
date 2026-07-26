# Workspace Guidelines

## Responsive UI & Global CSS Standards
- **Use Global CSS Classes**: When building or modifying windows, views, and pages, always reuse the global dashboard layout classes and CSS variables (e.g. `var(--border)`, `var(--primary)`, `var(--radius-lg)`, `var(--surface)`) defined in `index.css` and `TempMonitor.css`.
- **Prevent Multi-Column Grid Overflows**: Always set `min-width: 0;` and `overflow: hidden;` on grid cells containing nowrap text or buttons, to ensure browser flex/grid layouts shrink properly instead of horizontally stretching and cutting content on high zoom levels.
- **Maintain Mobile Responsiveness**: Ensure all grids collapse cleanly at standard break points (`@media (max-width: 1150px)` to 2 columns, `@media (max-width: 480px)` to 1 column) so that layouts fit perfectly on small viewports without breaking.
- **No Unused Spacer Elements**: Rely on CSS Grid auto-flow and standard container boundaries rather than inserting empty spacers that introduce empty gaps or alignment errors.
- **State Persistence on Refresh**: Ensure active menu tabs/views are saved in `localStorage` so refreshing the browser retains the user's current view.
