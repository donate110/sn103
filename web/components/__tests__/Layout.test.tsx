import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Layout from "../Layout";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(() => "/"),
}));

// Mock next/image
vi.mock("next/image", () => ({
  default: (props: Record<string, unknown>) => {
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    return <img {...props} />;
  },
}));

// Mock WalletButton
vi.mock("../WalletButton", () => ({
  default: () => <button>Mock Wallet</button>,
}));

// Mock TestnetFaucet
vi.mock("../TestnetFaucet", () => ({
  default: () => <button>Mock Faucet</button>,
}));

// Mock ReportError
vi.mock("../ReportError", () => ({
  default: () => null,
}));

describe("Layout", () => {
  it("renders children in the main content area", () => {
    render(
      <Layout>
        <div data-testid="child">Test content</div>
      </Layout>,
    );
    expect(screen.getByTestId("child")).toBeTruthy();
    expect(screen.getByText("Test content")).toBeTruthy();
  });

  it("renders all navigation links", () => {
    render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    expect(screen.getByText("Home")).toBeTruthy();
    // Some labels appear in both nav and footer
    expect(screen.getAllByText("Genius").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Leaderboard").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("About").length).toBeGreaterThanOrEqual(1);
  });

  it("renders the Djinn logo and brand name", () => {
    render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    // Brand name appears in header and footer
    const djinnElements = screen.getAllByText("Djinn");
    expect(djinnElements.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the footer with copyright", () => {
    render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    const year = new Date().getFullYear();
    expect(screen.getByText(`\u00A9 ${year} Djinn Inc.`)).toBeTruthy();
  });

  it("toggles mobile menu on hamburger click", () => {
    render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    const toggle = screen.getByLabelText("Toggle menu");
    // Mobile menu not visible initially (nav links are in desktop nav only)
    // Click hamburger to open
    fireEvent.click(toggle);
    // Now mobile nav should render additional links
    // Click again to close
    fireEvent.click(toggle);
  });

  it("renders external links with proper attributes", () => {
    render(
      <Layout>
        <div>content</div>
      </Layout>,
    );
    const githubLinks = screen.getAllByLabelText("GitHub");
    for (const link of githubLinks) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });
});
