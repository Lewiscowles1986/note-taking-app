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
      },
      "post": {
        "tags": ["pets"],
        "summary": "Create a pet",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "required": ["name"],
                "properties": {
                  "name": { "type": "string" },
                  "age": { "type": "integer" }
                }
              }
            }
          }
        },
        "responses": {
          "201": { "description": "Created" }
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
  it('renders header with version and online badge', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    expect(screen.getByText('openapi')).toBeInTheDocument();
    expect(screen.getByText('v1.0.2')).toBeInTheDocument();
    expect(screen.getByTestId('swagger-online-badge')).toHaveTextContent('Online');
  });

  it('renders tag groups, method chips, and paths', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    expect(screen.getByText('pets')).toBeInTheDocument();
    // Two operations share the path; collapsed rows are the only matches
    expect(screen.getAllByText('/pets').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('List pets')).toBeInTheDocument();
  });

  it('frontmatter servers override spec servers in the selector', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['0', '1']);
    expect(select.options[0].textContent).toBe('https://override.example.com');
    expect(select.options[1].textContent).toContain('https://backup.example.com/v2');
    expect(screen.getByText('overridden')).toBeInTheDocument();
  });

  it('falls back to spec servers when frontmatter has none', async () => {
    const code = JSON_SPEC.replace('---\nservers:\n  - https://override.example.com\n  - https://backup.example.com/v2\nnotes: Internal API — use with care\n---\n', '');
    render(<SwaggerBlock code={code} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe('https://spec.example.com/v1');
    expect(screen.queryByText('overridden')).not.toBeInTheDocument();
  });

  it('hides notes behind a toggle in the header (collapsed by default)', async () => {
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

  it('renders no notes toggle when frontmatter has no notes', async () => {
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

  it('renders YAML specs too', async () => {
    render(<SwaggerBlock code={YAML_SPEC} />);
    expect(screen.getByText('YAML API')).toBeInTheDocument();
    expect(screen.getByText('/dogs')).toBeInTheDocument();
    expect(screen.getByText('canine')).toBeInTheDocument();
  });

  it('shows a parse error for invalid specs', async () => {
    render(<SwaggerBlock code='{ "openapi": "3.0.0" }' />);
    expect(screen.getByText(/Missing required "info"/)).toBeInTheDocument();
  });

  it('shows the Spec tab with copyable spec text (frontmatter stripped)', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByText('Spec'));
    const pre = screen.getByText((_, el) => el?.tagName === 'CODE' && el.textContent?.includes('"openapi"') === true);
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).not.toContain('override.example.com');
    expect(screen.getByText('Copy')).toBeInTheDocument();
  });

  it('marks Swagger 2.0 specs', async () => {
    const v2 = 'swagger: "2.0"\ninfo:\n  title: Old\n  version: 1.0\npaths:\n  /x:\n    get:\n      responses:\n        "200": { description: ok }';
    render(<SwaggerBlock code={v2} />);
    expect(screen.getByText(/Swagger 2.0 spec/)).toBeInTheDocument();
  });
});

describe('Try it out', () => {
  it('renders a nested request-body editor seeded from the schema sample', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(input.value).toBe('{\n  "name": "string",\n  "age": 1\n}');
    // Single media type → plain label, no dropdown
    expect(screen.getByText('application/json')).toBeInTheDocument();
    expect(screen.queryByTestId('body-media-post:/pets')).not.toBeInTheDocument();
  });

  it('labels the surface as a body editor with live highlighting', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    expect(screen.getByText('Body editor')).toBeInTheDocument();
    const ta = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(ta.placeholder).toMatch(/type here/i);
  });

  it('offers spec examples in a Load example dropdown', async () => {
    const spec = JSON_SPEC.replace(
      '"application/json": {',
      '"application/json": {\n        "examples": { "dog": { "summary": "A dog", "value": { "name": "Rex" } }, "cat": { "summary": "A cat", "value": { "name": "Whiskers", "age": 2 } } },'
    );
    render(<SwaggerBlock code={spec} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const select = screen.getByTestId('body-example-post:/pets') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(['Load example…', 'A dog', 'A cat', 'Schema sample', 'Empty']);
    fireEvent.change(select, { target: { value: 'A cat' } });
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(JSON.parse(input.value)).toEqual({ name: 'Whiskers', age: 2 });
  });

  it('saves the current body as a reusable example (starred in the dropdown)', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: '{"name":"Custom"}' } });
    fireEvent.click(screen.getByTestId('body-save-post:/pets'));
    const select = screen.getByTestId('body-example-post:/pets') as HTMLSelectElement;
    const savedOption = Array.from(select.options).find((o) => o.textContent === '★ Saved 1');
    expect(savedOption).toBeDefined();
    expect(savedOption?.value).toBe('★ Saved 1');
    // Overwrite the editor, then load the saved example back
    fireEvent.change(input, { target: { value: '{}' } });
    fireEvent.change(select, { target: { value: '★ Saved 1' } });
    expect(((await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement).value).toBe('{"name":"Custom"}');
  });

  it('reset restores the seed example', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: 'garbage' } });
    fireEvent.click(screen.getByTestId('body-reset-post:/pets'));
    expect(((await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement).value).toBe('{\n  "name": "string",\n  "age": 1\n}');
  });

  it('keeps per-media-type drafts when switching and reseeds unseen types', async () => {
    const multiSpec = JSON_SPEC.replace(
      '"application/json": {',
      '"text/plain": { "schema": { "type": "string" } },\n          "application/json": {'
    );
    render(<SwaggerBlock code={multiSpec} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const select = screen.getByTestId('body-media-post:/pets') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    fireEvent.change(select, { target: { value: 'text/plain' } });
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(input.value).toBe('string');
    // Draft for json is retained when switching back
    fireEvent.change(input, { target: { value: 'edited text' } });
    fireEvent.change(select, { target: { value: 'application/json' } });
    expect(((await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement).value).toBe('{\n  "name": "string",\n  "age": 1\n}');
    fireEvent.change(select, { target: { value: 'text/plain' } });
    expect(((await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement).value).toBe('edited text');
  });

  it('edits the body and sends it with a Content-Type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('"ok"', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: '{"name":"Rex"}' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-post:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"Rex"}',
    });
    await waitFor(() => {
      expect(screen.getByTestId('tryit-output-post:/pets')).toHaveTextContent('HTTP 201');
    });
  });

  it('omits the body entirely when the editor is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-post:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets', {
      method: 'POST',
      headers: {},
      body: undefined,
    });
  });

  it('GET requests never send a body even if typed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    // get /pets has no requestBody → no editor, and no body is passed
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    expect(screen.queryByTestId('body-input-get:/pets')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });
    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets?limit=5', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('renders editable value inputs for query parameters, seeded from schema examples', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    const input = (await screen.findByTestId('param-query-limit')) as HTMLInputElement;
    expect(input.value).toBe('5'); // from schema example
    expect(input.type).toBe('number'); // integer schema
  });

  it('sends the user-typed query value instead of the example', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    const input = await screen.findByTestId('param-query-limit');
    fireEvent.change(input, { target: { value: '42' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });
    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets?limit=42', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('renders enum parameters as a dropdown seeded from schema.enum', async () => {
    const enumSpec = JSON_SPEC.replace(
      '{ "name": "limit", "in": "query", "schema": { "type": "integer", "example": 5 } }',
      '{ "name": "status", "in": "query", "required": true, "schema": { "type": "string", "default": "pending", "enum": ["available", "pending", "sold"] } }'
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={enumSpec} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    // A <select> replaces the plain input for enum params
    const select = (await screen.findByTestId('param-query-status')) as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.value)).toEqual(['available', 'pending', 'sold']);
    expect(select.value).toBe('pending'); // schema default seeds the choice

    // The selected enum value is what gets sent as the query param
    fireEvent.change(select, { target: { value: 'sold' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });
    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets?status=sold', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('renders Swagger 2.0 top-level enum parameters as dropdowns too', () => {
    const swagger2Spec = `swagger: "2.0"
info:
  title: V2 API
  version: 1.0.0
paths:
  /pet/findByStatus:
    get:
      tags: [pet]
      summary: Finds Pets by status
      parameters:
        - name: status
          in: query
          type: string
          enum:
            - available
            - pending
            - sold
      responses:
        "200": { description: ok }
`;
    render(<SwaggerBlock code={swagger2Spec} />);
    fireEvent.click(screen.getByTestId('op-get:/pet/findByStatus'));
    const select = screen.getByTestId('param-query-status') as HTMLSelectElement;
    expect(select.tagName).toBe('SELECT');
    expect([...select.options].map((o) => o.value)).toEqual(['available', 'pending', 'sold']);
  });

  it('substitutes path parameters into the URL and blocks missing required ones', async () => {
    const pathSpec = JSON_SPEC.replace(
      '"/pets": {',
      '"/pets/{petId}": { "get": { "tags": ["pets"], "summary": "Get one pet", "parameters": [ { "name": "petId", "in": "path", "required": true, "schema": { "type": "integer" } } ], "responses": { "200": { "description": "ok" } } } },\n    "/pets": {'
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={pathSpec} />);
    fireEvent.click(screen.getByTestId('op-get:/pets/{petId}'));
    await screen.findByTestId('param-path-petId');
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets/{petId}'));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('tryit-output-get:/pets/{petId}')).toHaveTextContent('Missing required parameter(s): petId');

    fireEvent.change(screen.getByTestId('param-path-petId'), { target: { value: '7' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets/{petId}'));
    });
    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets/7', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
  });

  it('explains CORS rejections instead of showing a bare Failed to fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-get:/pets'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-get:/pets'));
    });
    const out = await screen.findByTestId('tryit-output-get:/pets');
    expect(out).toHaveTextContent(/Request blocked/);
    expect(out).toHaveTextContent(/CORS/);
    expect(out).toHaveTextContent('https://override.example.com/pets?limit=5');
  });

  it('switches media types and reseeds the editor', async () => {
    const multiSpec = JSON_SPEC.replace(
      '"application/json": {',
      '"text/plain": { "schema": { "type": "string" } },\n          "application/json": {'
    );
    render(<SwaggerBlock code={multiSpec} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const select = screen.getByTestId('body-media-post:/pets') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    fireEvent.change(select, { target: { value: 'text/plain' } });
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(input.value).toBe('string');
  });

  it('renders a nested request-body editor seeded from the schema sample', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(input.value).toBe('{\n  "name": "string",\n  "age": 1\n}');
    // Single media type → plain label, no dropdown
    expect(screen.getByText('application/json')).toBeInTheDocument();
    expect(screen.queryByTestId('body-media-post:/pets')).not.toBeInTheDocument();
  });

  it('shows the example dropdown even with a single built-in example', async () => {
    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const select = (await screen.findByTestId('body-example-post:/pets')) as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Schema sample');
    expect(labels).toContain('Empty');
    expect(labels[0]).toBe('Load example…');
  });

  it('multipart bodies get a field editor and send real FormData', async () => {
    const multipartSpec = JSON_SPEC.replace(
      '"application/json": {',
      '"multipart/form-data": { "schema": { "type": "object" } },\n          "application/json": {'
    );
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={multipartSpec} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const media = await screen.findByTestId('body-media-post:/pets');
    fireEvent.change(media, { target: { value: 'multipart/form-data' } });
    const nameInput = await screen.findByTestId('multipart-name-post:/pets-0');
    fireEvent.change(nameInput, { target: { value: 'name' } });
    const valueInput = await screen.findByTestId('multipart-value-post:/pets-0');
    fireEvent.change(valueInput, { target: { value: 'Rex' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('try-post:/pets'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('name')).toBe('Rex');
    // No manual Content-Type: the browser must add the multipart boundary.
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('edits the body and sends it with a Content-Type header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('"ok"', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: '{"name":"Rex"}' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-post:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"Rex"}',
    });
    await waitFor(() => {
      expect(screen.getByTestId('tryit-output-post:/pets')).toHaveTextContent('HTTP 201');
    });
  });

  it('omits the body entirely when the editor is blank', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<SwaggerBlock code={JSON_SPEC} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const input = (await screen.findByTestId('body-input-post:/pets'));
    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('try-post:/pets'));
    });

    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets', {
      method: 'POST',
      headers: {},
      body: undefined,
    });
  });


  it('switches media types and reseeds the editor', async () => {
    const multiSpec = JSON_SPEC.replace(
      '"application/json": {',
      '"text/plain": { "schema": { "type": "string" } },\n          "application/json": {'
    );
    render(<SwaggerBlock code={multiSpec} />);
    fireEvent.click(screen.getByTestId('op-post:/pets'));
    const select = screen.getByTestId('body-media-post:/pets') as HTMLSelectElement;
    expect(select.options.length).toBe(2);
    fireEvent.change(select, { target: { value: 'text/plain' } });
    const input = (await screen.findByTestId('body-input-post:/pets')) as HTMLTextAreaElement;
    expect(input.value).toBe('string');
  });

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

    expect(fetchMock).toHaveBeenCalledWith('https://override.example.com/pets?limit=5', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
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

    expect(fetchMock).toHaveBeenCalledWith('https://backup.example.com/v2/pets?limit=5', {
      method: 'GET',
      headers: {},
      body: undefined,
    });
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

  it('reacts to online/offline window events', async () => {
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