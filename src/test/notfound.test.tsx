import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import NotFound from "../pages/NotFound";

const LOG_PREFIX = "404 Error: User attempted to access non-existent route:";

// The page logs every unmatched route through console.error; silence and spy it.
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

describe("NotFound page", () => {
  beforeEach(() => {
    consoleErrorSpy.mockClear();
  });

  const notFoundLogs = () =>
    consoleErrorSpy.mock.calls.filter(([message]) => message === LOG_PREFIX);

  function renderNotFoundAt(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("renders the 404 heading, message and return-to-home link", () => {
    renderNotFoundAt("/definitely/missing");

    expect(screen.getByRole("heading", { level: 1, name: "404" })).toBeInTheDocument();
    expect(screen.getByText("Oops! Page not found")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Return to Home" })).toHaveAttribute("href", "/");
  });

  it("logs the attempted route on mount", () => {
    renderNotFoundAt("/oops/nope");

    expect(consoleErrorSpy).toHaveBeenCalledWith(LOG_PREFIX, "/oops/nope");
    expect(notFoundLogs()).toHaveLength(1);
  });

  it("logs again when the user navigates to another missing route", () => {
    render(
      <MemoryRouter initialEntries={["/first-missing-route"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <NotFound />
                <Link to="/second-missing-route">Go elsewhere</Link>
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    );

    expect(notFoundLogs()).toHaveLength(1);
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(1, LOG_PREFIX, "/first-missing-route");

    fireEvent.click(screen.getByRole("link", { name: "Go elsewhere" }));

    expect(notFoundLogs()).toHaveLength(2);
    expect(consoleErrorSpy).toHaveBeenNthCalledWith(2, LOG_PREFIX, "/second-missing-route");
  });
});