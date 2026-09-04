import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { NavLink } from "../components/NavLink";

describe("NavLink component", () => {
  it("applies activeClassName only to the link matching the current route", () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <NavLink to="/inbox" className="base-link" activeClassName="is-active">
          Inbox
        </NavLink>
        <NavLink to="/sent" className="base-link" activeClassName="is-active">
          Sent
        </NavLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Inbox" })).toHaveClass("base-link", "is-active");
    expect(screen.getByRole("link", { name: "Sent" })).toHaveClass("base-link");
    expect(screen.getByRole("link", { name: "Sent" })).not.toHaveClass("is-active");
  });

  it("matches nested routes by default and only the exact route with end", () => {
    render(
      <MemoryRouter initialEntries={["/inbox/123"]}>
        <NavLink to="/inbox" className="base-link" activeClassName="is-active">
          Prefix
        </NavLink>
        <NavLink to="/inbox" end className="base-link" activeClassName="is-active">
          Exact
        </NavLink>
        <NavLink to="/inbox/123" end className="base-link" activeClassName="is-active">
          Deep
        </NavLink>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Prefix" })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Exact" })).not.toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Deep" })).toHaveClass("is-active");
  });

  it("omits pendingClassName while the navigation is not pending", () => {
    render(
      <MemoryRouter initialEntries={["/inbox"]}>
        <NavLink
          to="/inbox"
          className="base-link"
          activeClassName="is-active"
          pendingClassName="is-pending"
        >
          Idle
        </NavLink>
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Idle" });
    expect(link).toHaveClass("base-link", "is-active");
    expect(link).not.toHaveClass("is-pending");
  });

  it("forwards its ref to the underlying anchor and passes anchor props through", () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <MemoryRouter initialEntries={["/"]}>
        <NavLink ref={ref} to="/" id="home-link" className="base-link">
          Home
        </NavLink>
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Home" });
    expect(ref.current).toBeInstanceOf(HTMLAnchorElement);
    expect(link).toBe(ref.current);
    expect(ref.current?.id).toBe("home-link");
  });
});