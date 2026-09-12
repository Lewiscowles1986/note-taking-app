import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SwaggerBlock from '../components/SwaggerBlock';

const JSON_SPEC = `---
servers:
  - https://override.example.com
  - https://backup.example.com/v2
notes: Internal API — use with care
---
{
  "openapi": "3.0.3",
  "info": { "title": "Pet Store", "version": "1.0.2" },
  "servers": [{ "url": "https://spec.example.com/v1" }],
  "paths": {
    "/pets": {
      "get": {
        "tags": ["pets"],
        "summary": "List pets",
        "parameters": [
          { "name": "limit", "in": "query", "schema": { "type": "integer", "example": 5 } }
        ],
        "responses": {
          "200": { "description": "A list of pets" },
          "404": { "description": "Not found" }
        }
      }
    }
  }
}`;

const YAML_SPEC = `openapi: 3.0.3
info:
  title: YAML API
  version: 2.0.0
paths:
  /dogs:
    get:
      tags: [canine]
      summary: List dogs
      responses:
        "200": { description: Woof }
`;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SwaggerBlock rendering', () => {
  it('renders header with version and online badge', () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    expect(screen.getByText('openapi')).toBeInTheDocument();
    expect(screen.getByText('v1.0.2')).toBeInTheDocument();
    expect(screen.getByTestId('swagger-online-badge')).toHaveTextContent('Online');
  });

  it('renders tag groups, method chips, and paths', () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    expect(screen.getByText('pets')).toBeInTheDocument();
    expect(screen.getByText('/pets')).toBeInTheDocument();
    expect(screen.getByText('List pets')).toBeInTheDocument();
  });

  it('frontmatter servers override spec servers in the selector', () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['0', '1']);
    expect(select.options[0].textContent).toBe('https://override.example.com');
    expect(select.options[1].textContent).toContain('https://backup.example.com/v2');
    expect(screen.getByText('overridden')).toBeInTheDocument();
  });

  it('falls back to spec servers when frontmatter has none', () => {
    const code = JSON_SPEC.replace('---\nservers:\n  - https://override.example.com\n  - https://backup.example.com/v2\nnotes: Internal API — use with care\n---\n', '');
    render(<SwaggerBlock code={code} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('https://spec.example.com/v1');
    expect(screen.queryByText('overridden')).not.toBeInTheDocument();
  });

  it('hides notes behind a toggle in the header (collapsed by default)', () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    // Collapsed by default — no amber panel
    expect(screen.queryByTestId('swagger-notes-panel')).not.toBeInTheDocument();
    // Toggle sits left of the API Preview tab
    fireEvent.click(screen.getByTestId('swagger-notes-toggle'));
    expect(screen.getByTestId('swagger-notes-panel')).toHaveTextContent('Internal API — use with care');
    // Toggle again to collapse
    fireEvent.click(screen.getByTestId('swagger-notes-toggle'));
    expect(screen.queryByTestId('swagger-notes-panel')).not.toBeInTheDocument();
  });

  it('renders no notes toggle when frontmatter has no notes', () => {
    const code = JSON_SPEC.replace('notes: Internal API — use with care\n', '');
    render(<SwaggerBlock code={code} />);
    expect(screen.queryByTestId('swagger-notes-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('swagger-notes-panel')).not.toBeInTheDocument();
  });

  it('expands an operation and shows params, responses, and Try it out', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    expect(screen.getByTestId('op-params')).toBeInTheDocument();
    expect(screen.getByText('query')).toBeInTheDocument();
    expect(screen.getByText('integer')).toBeInTheDocument();
    expect(screen.getByText('A list of pets')).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.getByTestId('try-get:/pets')).toBeInTheDocument();
  });

  it('renders YAML specs too', () => {
    render(<SwaggerBlock code={YAML_SPEC} />);
    expect(screen.getByText('YAML API')).toBeInTheDocument();
    expect(screen.getByText('/dogs')).toBeInTheDocument();
    expect(screen.getByText('canine')).toBeInTheDocument();
  });

  it('shows a parse error for invalid specs', () => {
    render(<SwaggerBlock code='{ "openapi": "3.0.0" }' />);
    expect(screen.getByText(/Missing required "info"/)).toBeInTheDocument();
  });

  it('shows the Spec tab with copyable spec text (frontmatter stripped)', () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByText('Spec'));
    const pre = screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent?.includes('"openapi"') === true);
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).not.toContain('override.example.com');
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('marks Swagger 2.0 specs', () => {
    const v2 = 'swagger: "2.0"\ninfo:\n  title: Old\n  version: 1.0\npaths:\n  /x:\n    get:\n      responses:\n        "200": { description: ok }';
    render(<SwaggerBlock code={v2} />);
    expect(screen.getByText(/Swagger 2.0 spec/)).toBeInTheDocument();
  });
});

describe('Try it out', () => {
  it('sends a GET to the selected server with query examples', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 1, name: 'Rex' }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://override.example.com/pets?limit=5',
      { method: 'GET' }
    );
    await waitFor(() => {
      expect(screen.getByTestId('tryit-output-get:/pets')).toHaveTextContent('HTTP 200');
      expect(screen.getByTestId('tryit-output-get:/pets')).toHaveTextContent('Rex');
    });
  });

  it('uses the server selected in the dropdown', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '1' } });
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backup.example.com/v2/pets?limit=5',
      { method: 'GET' }
    );
  });

  it('reports fetch errors in the red panel', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });

    await waitFor(() => {
      expect(screen.getByTestId('tryit-output-get:/pets')).toHaveTextContent('network down');
    });
  });

  it('refuses to run when offline', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // jsdom's navigator.onLine defaults to true; force offline for this test.
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false });
    try {
      render(<SwaggerBlock code={JSON_SPEC} />);
      expect(screen.getByTestId('swagger-online-badge')).toHaveTextContent('Offline');
      fireEvent.click(screen.getByTestId('op-get:/pets'));
      await act(async () => {
        fireEvent.click(screen.getByTestId('try-get:/pets'));
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId('tryit-output-get:/pets')).toHaveTextContent(/Offline/);
    } finally {
      if (original) Object.defineProperty(Navigator.prototype, 'onLine', original);
    }
  });

  it('reacts to online/offline window events', () => {
    // jsdom never flips navigator.onLine on synthetic events, so drive it
    // directly: the component re-reads navigator.onLine in its event handler.
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
    let current = true;
    Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => current });
    try {
      render(<SwaggerBlock code={JSON_SPEC} />);
      const badge = screen.getByTestId('swagger-online-badge');
      expect(badge).toHaveTextContent('Online');
      act(() => {
        current = false;
        window.dispatchEvent(new Event('offline'));
      });
      expect(badge).toHaveTextContent('Offline');
      act(() => {
        current = true;
        window.dispatchEvent(new Event('online'));
      });
      expect(badge).toHaveTextContent('Online');
    } finally {
      if (original) Object.defineProperty(Navigator.prototype, 'onLine', original);
    }
  });

  it('errors cleanly when no server is configured', async () => {
    const noServerSpec = `{
  "openapi": "3.0.3",
  "info": { "title": "No Server", "version": "1.0.0" },
  "paths": {
    "/pets": {
      "get": { "summary": "List pets", "responses": { "200": { "description": "ok" } } }
    }
  }
}`;
    render(<SwaggerBlock code={noServerSpec} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });
    expect(screen.getByTestId('tryit-output-get:/pets')).toHaveTextContent('No server configured');
  });
});