import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DesignSystemStyles } from './design-system-styles';

describe('DesignSystemStyles', () => {
  it('marks the inline stylesheet with the request CSP nonce', () => {
    const { container } = render(<DesignSystemStyles nonce="request-nonce" />);
    const stylesheet = container.querySelector('style');

    expect(stylesheet?.getAttribute('nonce')).toBe('request-nonce');
    expect(stylesheet?.textContent).not.toBe('');
  });
});
