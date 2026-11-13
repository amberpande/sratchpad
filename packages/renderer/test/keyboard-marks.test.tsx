import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InteractionContext, WidgetIdContext, type InteractionEngine } from '../src/interactions';
import { KeyboardMarks } from '../src/widgets/KeyboardMarks';

// Keyboard selection of chart marks (D-091).
describe('KeyboardMarks', () => {
  it('moves with the arrow keys and selects with Enter', () => {
    const select = vi.fn();
    const engine: InteractionEngine = { forWidget: () => ({ interactive: true, select, isSelected: () => undefined }) };
    const widget = { type: 'bar-chart', query: 'q', encoding: { x: 'region', y: 'n' }, options: {} } as never;
    const result = { columns: [{ name: 'region', type: 'string' as const }, { name: 'n', type: 'number' as const }], rows: [{ region: 'EU', n: 1 }, { region: 'US', n: 2 }], truncated: false };
    render(
      <InteractionContext.Provider value={engine}>
        <WidgetIdContext.Provider value={{ id: 'w', widget }}>
          <KeyboardMarks widget={widget} result={result} format={{ locale: 'en-US', currency: 'USD' }} title="Orders" />
        </WidgetIdContext.Provider>
      </InteractionContext.Provider>,
    );
    const bar = screen.getByRole('toolbar');
    expect(bar.textContent).toContain('EU');
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(bar.textContent).toContain('US');
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(select).toHaveBeenCalledWith({ field: 'region', value: 'US' }, { additive: false });
  });
});
