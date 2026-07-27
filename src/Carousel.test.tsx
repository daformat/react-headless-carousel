import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Carousel } from "./Carousel.js";
import type { MaybeUndefined } from "./utils/maybe.js";

// --- Helpers ---

/**
 * jsdom has no layout engine. This stubs the three properties the component
 * reads to decide whether—and how far—it can scroll.
 *
 * Default values produce a container that is 300px wide and has 1000px of
 * scrollable content, starting at scrollLeft=0.
 */
const stubViewportLayout = (
  el: HTMLElement,
  {
    scrollWidth = 1000,
    offsetWidth = 300,
    scrollLeft = 0,
  }: { scrollWidth?: number; offsetWidth?: number; scrollLeft?: number } = {},
) => {
  let _scrollLeft = scrollLeft;
  Object.defineProperty(el, "scrollWidth", {
    get: () => scrollWidth,
    configurable: true,
  });
  Object.defineProperty(el, "offsetWidth", {
    get: () => offsetWidth,
    configurable: true,
  });
  Object.defineProperty(el, "scrollLeft", {
    get: () => _scrollLeft,
    set: (v: number) => {
      _scrollLeft = v;
    },
    configurable: true,
  });
  el.scrollTo = vi.fn();
};

const getViewport = () =>
  document.querySelector("[data-carousel-viewport]") as HTMLElement;

/**
 * Renders a full carousel with five items and prev/next buttons.
 * boundaryOffset is fixed to {x:0, y:0} to avoid CSS-variable resolution in
 * jsdom, where getComputedStyle does not honour SCSS-defined custom properties.
 * Looping is off by default: most of the suite is about what happens at the
 * boundaries, which a looping carousel does not have.
 */
const renderCarousel = (
  viewportProps: Partial<Parameters<typeof Carousel.Viewport>[0]> = {},
  rootProps: Partial<Parameters<typeof Carousel.Root>[0]> = {},
) =>
  render(
    <Carousel.Root boundaryOffset={{ x: 0, y: 0 }} loop={false} {...rootProps}>
      <Carousel.Viewport {...viewportProps}>
        <Carousel.Content>
          {Array.from({ length: 5 }, (_, i) => (
            <Carousel.Item key={i}>
              <div>Item {i}</div>
            </Carousel.Item>
          ))}
        </Carousel.Content>
      </Carousel.Viewport>
      <Carousel.PrevPage>prev</Carousel.PrevPage>
      <Carousel.NextPage>next</Carousel.NextPage>
    </Carousel.Root>,
  );

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Stub MutationObserver so updateScrollState is only triggered by explicit
  // scroll events in the tests, not by incidental DOM mutations.
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // Prevent momentum animation side effects—the component uses rAF internally
  // and we don't want frames firing between assertions.
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());

  // jsdom does not implement these pointer capture APIs — define them as no-ops
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

// --- Tests ---

describe("Carousel", () => {
  describe("structural rendering", () => {
    it("Root renders its children", () => {
      render(
        <Carousel.Root>
          <span>hello</span>
        </Carousel.Root>,
      );
      expect(document.querySelector("span")?.textContent).toBe("hello");
    });

    it("Viewport is marked with data-carousel-viewport", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport>content</Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(document.querySelector("[data-carousel-viewport]")).not.toBeNull();
    });

    it("Content is marked with data-carousel-content", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport>
            <Carousel.Content>items</Carousel.Content>
          </Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(document.querySelector("[data-carousel-content]")).not.toBeNull();
    });

    it("Item is marked with data-carousel-item", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport>
            <Carousel.Content>
              <Carousel.Item>
                <span>item</span>
              </Carousel.Item>
            </Carousel.Content>
          </Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(document.querySelector("[data-carousel-item]")).not.toBeNull();
    });

    it("Item asChild merges data-carousel-item onto the child element without wrapping it", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport>
            <Carousel.Content>
              <Carousel.Item asChild>
                <a href="/foo">link</a>
              </Carousel.Item>
            </Carousel.Content>
          </Carousel.Viewport>
        </Carousel.Root>,
      );
      const link = screen.getByRole("link");
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("data-carousel-item")).toBe("");
    });
  });

  describe("data-can-scroll attribute", () => {
    it("is 'none' when all content fits inside the viewport", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollWidth: 200, offsetWidth: 300 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(vp.getAttribute("data-can-scroll")).toBe("none");
      });
    });

    it("is 'forwards' when at the start of an overflowing list", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 0 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(vp.getAttribute("data-can-scroll")).toBe("forwards");
      });
    });

    it("is 'backwards' when scrolled to the end", async () => {
      renderCarousel();
      const vp = getViewport();
      // max scrollLeft = scrollWidth(1000) - offsetWidth(300) = 700
      stubViewportLayout(vp, { scrollLeft: 700 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(vp.getAttribute("data-can-scroll")).toBe("backwards");
      });
    });

    it("is 'both' when scrolled partway through", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 350 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(vp.getAttribute("data-can-scroll")).toBe("both");
      });
    });
  });

  describe("PrevPage / NextPage disabled state", () => {
    it("both buttons are disabled when all content is visible", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollWidth: 200, offsetWidth: 300 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "prev" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("button", { name: "next" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
      });
    });

    it("PrevPage is disabled and NextPage is enabled at the start", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 0 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "prev" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("button", { name: "next" }) as HTMLButtonElement)
            .disabled,
        ).toBe(false);
      });
    });

    it("NextPage is disabled and PrevPage is enabled at the end", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 700 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "next" }) as HTMLButtonElement)
            .disabled,
        ).toBe(true);
        expect(
          (screen.getByRole("button", { name: "prev" }) as HTMLButtonElement)
            .disabled,
        ).toBe(false);
      });
    });
  });

  describe("PrevPage / NextPage trigger scroll", () => {
    it("clicking NextPage calls scrollTo on the viewport", async () => {
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 0 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "next" }) as HTMLButtonElement)
            .disabled,
        ).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: "next" }));
      expect(vp.scrollTo).toHaveBeenCalled();
    });

    it("clicking PrevPage calls scrollTo on the viewport", async () => {
      renderCarousel();
      const vp = getViewport();
      // mid-scroll so both buttons are enabled
      stubViewportLayout(vp, { scrollLeft: 350 });
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(
          (screen.getByRole("button", { name: "prev" }) as HTMLButtonElement)
            .disabled,
        ).toBe(false);
      });
      fireEvent.click(screen.getByRole("button", { name: "prev" }));
      expect(vp.scrollTo).toHaveBeenCalled();
    });
  });

  describe("contentFade prop", () => {
    it("applies a mask-image when contentFade is true (default)", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport contentFade>content</Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(getViewport().style.maskImage).toContain("linear-gradient");
    });

    it("does not apply a mask-image when contentFade is false", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport contentFade={false}>content</Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(getViewport().style.maskImage).toBe("");
    });

    it("uses contentFadeSize to set the --carousel-fade-size CSS variable", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport contentFade contentFadeSize="48px">
            content
          </Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(getViewport().style.getPropertyValue("--carousel-fade-size")).toBe(
        "48px",
      );
    });

    it("converts a numeric contentFadeSize to a px value", () => {
      render(
        <Carousel.Root>
          <Carousel.Viewport contentFade contentFadeSize={32}>
            content
          </Carousel.Viewport>
        </Carousel.Root>,
      );
      expect(getViewport().style.getPropertyValue("--carousel-fade-size")).toBe(
        "32px",
      );
    });
  });

  describe("click suppression during mouse drag", () => {
    const renderClickableCarousel = (onClick: () => void) =>
      render(
        <Carousel.Root boundaryOffset={{ x: 0, y: 0 }} loop={false}>
          <Carousel.Viewport>
            <Carousel.Content>
              <Carousel.Item>
                <button onClick={onClick}>clickable</button>
              </Carousel.Item>
            </Carousel.Content>
          </Carousel.Viewport>
        </Carousel.Root>,
      );

    it("suppresses clicks on children after a drag of more than 3px", () => {
      const onClick = vi.fn();
      renderClickableCarousel(onClick);
      const vp = getViewport();
      const btn = screen.getByRole("button", { name: "clickable" });

      // pointerDown on the inner button — capture listener on the viewport
      // sets initialTarget=btn and initialPointerPosition={x:0,y:0}
      fireEvent.pointerDown(btn, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        bubbles: true,
      });
      fireEvent.pointerMove(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 50,
        clientY: 0,
      });
      fireEvent.pointerUp(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 50,
        clientY: 0,
      });

      // A click fired after the drag should be suppressed by onClickCapture.
      // detail: 1 matches a real browser mouse-click (keyboard-synthesized clicks
      // have detail: 0 and must be allowed through for accessibility).
      fireEvent.click(btn, { detail: 1 });
      expect(onClick).not.toHaveBeenCalled();
    });

    it("allows clicks on children when the pointer barely moved (< 3px)", () => {
      const onClick = vi.fn();
      renderClickableCarousel(onClick);
      const vp = getViewport();
      const btn = screen.getByRole("button", { name: "clickable" });

      fireEvent.pointerDown(btn, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 0,
        clientY: 0,
        bubbles: true,
      });
      // Move less than 3px — the component dispatches a synthetic click on btn
      fireEvent.pointerUp(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 1,
        clientY: 0,
      });

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe("momentum scrolling", () => {
    /**
     * Override the no-op rAF stub (set in beforeEach) with one that queues the
     * callbacks so tests can invoke them manually, frame by frame.
     */
    const captureAnimationFrames = () => {
      const callbacks: FrameRequestCallback[] = [];
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn((cb: FrameRequestCallback) => {
          callbacks.push(cb);
          return callbacks.length;
        }),
      );
      return callbacks;
    };

    /**
     * Simulates a 100ms drag from fromX to toX.
     * vi.useFakeTimers gives us deterministic control over Date.now so the
     * component computes a real, non-zero velocity (velocityX = Δx / Δt).
     */
    const drag = (vp: HTMLElement, fromX: number, toX: number) => {
      vi.useFakeTimers({ toFake: ["Date"], now: 0 });
      fireEvent.pointerDown(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: fromX,
        clientY: 0,
      });
      vi.setSystemTime(100); // advance Date.now to 100 ms before pointerMove
      fireEvent.pointerMove(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: toX,
        clientY: 0,
      });
      fireEvent.pointerUp(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: toX,
        clientY: 0,
      });
      vi.useRealTimers();
    };

    it("schedules an animation frame after releasing with velocity", () => {
      const frames = captureAnimationFrames();
      renderCarousel();
      const vp = getViewport();
      // Start mid-scroll so the carousel can coast without hitting a boundary
      stubViewportLayout(vp, { scrollLeft: 300 });
      drag(vp, 100, 0); // 100px drag → velocityX = (0-100)/100 = -1 px/ms
      expect(frames.length).toBeGreaterThan(0);
    });

    it("advances scrollLeft when the first animation frame fires", () => {
      const frames = captureAnimationFrames();
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 300 });
      drag(vp, 100, 0);

      const scrollAfterDrag = vp.scrollLeft;
      frames[0]?.(0);
      expect(vp.scrollLeft).not.toBe(scrollAfterDrag);
    });

    it("decelerates — each successive frame covers less distance than the previous", () => {
      const frames = captureAnimationFrames();
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 300 });
      drag(vp, 100, 0);

      const s0 = vp.scrollLeft;
      frames[0]?.(0);
      const s1 = vp.scrollLeft;
      frames[1]?.(0);
      const s2 = vp.scrollLeft;

      // Each frame should move less than the one before due to deceleration
      expect(Math.abs(s2 - s1)).toBeLessThan(Math.abs(s1 - s0));
    });

    it("schedules a follow-up frame while velocity is still meaningful", () => {
      const frames = captureAnimationFrames();
      renderCarousel();
      const vp = getViewport();
      stubViewportLayout(vp, { scrollLeft: 300 });
      drag(vp, 100, 0);

      const countBeforeFirstFrame = frames.length;
      frames[0]?.(0);
      // The animate loop should have re-queued itself since velocity hasn't decayed yet
      expect(frames.length).toBeGreaterThan(countBeforeFirstFrame);
    });
  });

  describe("rubber-banding (overscroll)", () => {
    it("applies a CSS translate to items when dragging past the start boundary", () => {
      renderCarousel();
      const vp = getViewport();
      // offsetWidth must be non-zero so the rubber-band distance is meaningful
      stubViewportLayout(vp, {
        scrollLeft: 0,
        scrollWidth: 1000,
        offsetWidth: 300,
      });

      vi.useFakeTimers({ toFake: ["Date"], now: 0 });
      fireEvent.pointerDown(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      });
      vi.setSystemTime(100);
      // Dragging right (positive clientX) produces a negative scrollDelta,
      // pushing scrollLeft below 0 and triggering overscroll
      fireEvent.pointerMove(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 50,
        clientY: 0,
      });
      vi.useRealTimers();

      const items = Array.from(
        document.querySelectorAll("[data-carousel-item]"),
      ) as HTMLElement[];
      expect(items.length).toBeGreaterThan(0);
      // Every item should carry a non-trivial translate offset
      expect(
        items.every((item) =>
          (item.getAttribute("style") ?? "").includes("translate"),
        ),
      ).toBe(true);
    });

    it("does not apply rubber-banding when dragging within the normal scroll range", () => {
      renderCarousel();
      const vp = getViewport();
      // scrollLeft=300 is well within [0, 700], so no boundary is touched
      stubViewportLayout(vp, {
        scrollLeft: 300,
        scrollWidth: 1000,
        offsetWidth: 300,
      });

      vi.useFakeTimers({ toFake: ["Date"], now: 0 });
      fireEvent.pointerDown(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 100,
        clientY: 0,
      });
      vi.setSystemTime(100);
      // Drag left 20px → scrollDelta = +20 → scrollLeft = 320, well inside range
      fireEvent.pointerMove(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 80,
        clientY: 0,
      });
      vi.useRealTimers();

      const items = Array.from(
        document.querySelectorAll("[data-carousel-item]"),
      ) as HTMLElement[];
      expect(
        items.every(
          (item) => !(item.getAttribute("style") ?? "").includes("translate"),
        ),
      ).toBe(true);
    });
  });

  describe("loop", () => {
    const ITEM_WIDTH = 100;
    const VIEWPORT_WIDTH = 300;
    const CHILDREN_COUNT = 5;
    /** width of a single copy of the children */
    const NATURAL_WIDTH = ITEM_WIDTH * CHILDREN_COUNT;

    const patchedKeys = [
      "scrollLeft",
      "scrollWidth",
      "clientWidth",
      "offsetWidth",
      "getBoundingClientRect",
      "scrollTo",
    ] as const;
    const originalDescriptors = new Map<
      string,
      MaybeUndefined<PropertyDescriptor>
    >();

    const isViewport = (el: HTMLElement) =>
      el.hasAttribute("data-carousel-viewport");
    const isItem = (el: HTMLElement) => el.hasAttribute("data-carousel-item");
    const getViewportOf = (el: HTMLElement) =>
      isViewport(el) ? el : el.closest<HTMLElement>("[data-carousel-viewport]");
    const getContentWidth = (viewport: HTMLElement) => {
      const content = viewport.querySelector("[data-carousel-content]");
      return (content?.children.length ?? 0) * ITEM_WIDTH;
    };

    /**
     * jsdom has no layout engine, and the loop needs one: it measures how far
     * apart two copies of the children are to know its repetition period. This
     * installs a minimal horizontal layout on the prototypes — a viewport
     * VIEWPORT_WIDTH wide, holding items of ITEM_WIDTH laid out one after the
     * other from the start of the content — and has to be in place *before*
     * rendering, since the carousel measures itself in a layout effect.
     */
    const stubLayout = () => {
      const scrollPositions = new WeakMap<HTMLElement, number>();
      const patch = (key: string, descriptor: PropertyDescriptor) => {
        originalDescriptors.set(
          key,
          Object.getOwnPropertyDescriptor(HTMLElement.prototype, key),
        );
        Object.defineProperty(HTMLElement.prototype, key, {
          ...descriptor,
          configurable: true,
        });
      };

      patch("scrollLeft", {
        get(this: HTMLElement) {
          return scrollPositions.get(this) ?? 0;
        },
        set(this: HTMLElement, value: number) {
          // browsers clamp the scroll position to the scrollable range
          const maxScroll = Math.max(0, this.scrollWidth - this.clientWidth);
          scrollPositions.set(this, Math.max(0, Math.min(value, maxScroll)));
        },
      });
      patch("scrollWidth", {
        get(this: HTMLElement) {
          return isViewport(this) ? getContentWidth(this) : 0;
        },
      });
      patch("clientWidth", {
        get(this: HTMLElement) {
          return isViewport(this) ? VIEWPORT_WIDTH : 0;
        },
      });
      patch("offsetWidth", {
        get(this: HTMLElement) {
          return isViewport(this)
            ? VIEWPORT_WIDTH
            : isItem(this)
              ? ITEM_WIDTH
              : 0;
        },
      });
      patch("getBoundingClientRect", {
        value(this: HTMLElement) {
          const viewport = getViewportOf(this);
          const scrollLeft = viewport?.scrollLeft ?? 0;
          let left = 0;
          let width = 0;
          if (viewport === this) {
            width = VIEWPORT_WIDTH;
          } else if (isItem(this) && this.parentElement) {
            const index = Array.prototype.indexOf.call(
              this.parentElement.children,
              this,
            );
            left = index * ITEM_WIDTH - scrollLeft;
            width = ITEM_WIDTH;
          } else if (viewport) {
            left = -scrollLeft;
            width = getContentWidth(viewport);
          }
          return {
            x: left,
            y: 0,
            left,
            right: left + width,
            top: 0,
            bottom: 0,
            width,
            height: 0,
            toJSON: () => ({}),
          } as DOMRect;
        },
      });
      patch("scrollTo", {
        value(this: HTMLElement, options?: ScrollToOptions | number) {
          const left = typeof options === "number" ? options : options?.left;
          if (left !== undefined) {
            this.scrollLeft = left;
          }
        },
      });
    };

    const restoreLayout = () => {
      patchedKeys.forEach((key) => {
        const descriptor = originalDescriptors.get(key);
        if (descriptor) {
          Object.defineProperty(HTMLElement.prototype, key, descriptor);
        } else {
          delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
            key
          ];
        }
      });
      originalDescriptors.clear();
    };

    const renderLoopCarousel = (
      viewportProps: Partial<Parameters<typeof Carousel.Viewport>[0]> = {},
    ) => renderCarousel(viewportProps, { loop: true });

    const getContent = () =>
      document.querySelector("[data-carousel-content]") as HTMLElement;
    const getItems = () => Array.from(getContent().children) as HTMLElement[];
    /** Items rendered from the children the user passed, clones excluded */
    const getOriginalItems = () =>
      getItems().filter((item) => !item.hasAttribute("data-loop-clone"));

    beforeEach(stubLayout);
    afterEach(restoreLayout);

    it("repeats the children enough to fill the runway on both sides", () => {
      renderLoopCarousel();
      const items = getItems();
      // one set before, one set after, and each set is wider than the viewport
      expect(items.length % 3).toBe(0);
      expect((items.length / 3) * ITEM_WIDTH).toBeGreaterThan(VIEWPORT_WIDTH);
      // the children themselves are only ever rendered once
      expect(getOriginalItems()).toHaveLength(CHILDREN_COUNT);
    });

    it("renders the copies as hidden from assistive tech and unreachable by tab", () => {
      renderLoopCarousel();
      const clones = getItems().filter((item) =>
        item.hasAttribute("data-loop-clone"),
      );
      expect(clones.length).toBeGreaterThan(0);
      expect(
        clones.every(
          (clone) =>
            clone.getAttribute("aria-hidden") === "true" &&
            clone.getAttribute("tabindex") === "-1",
        ),
      ).toBe(true);
    });

    it("starts on the first original child, without having to scroll there", () => {
      renderLoopCarousel();
      const items = getItems();
      const firstOriginal = getOriginalItems()[0] as HTMLElement;
      // the first original child sits flush against the start of the viewport
      expect(getViewport().scrollLeft).toBe(
        items.indexOf(firstOriginal) * ITEM_WIDTH,
      );
    });

    it("does not touch the scroll position when looping is off", () => {
      renderCarousel();
      expect(getViewport().scrollLeft).toBe(0);
      expect(getItems()).toHaveLength(CHILDREN_COUNT);
    });

    /** How long the component waits for the scroll to go quiet */
    const SCROLL_IDLE_DELAY = 200;

    it("comes back to the original children once the scroll settles", () => {
      vi.useFakeTimers();
      renderLoopCarousel();
      const vp = getViewport();
      const home = vp.scrollLeft;
      const items = getItems();
      const drifted = home + 600;
      vp.scrollLeft = drifted;
      fireEvent.scroll(vp);
      expect(vp.scrollLeft).toBe(drifted);

      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);

      // it moved by a whole number of copies, so nothing moved on screen
      expect(vp.scrollLeft).not.toBe(drifted);
      expect((drifted - vp.scrollLeft) % NATURAL_WIDTH).toBe(0);
      // and it landed back on the original children, the ones assistive tech
      // and tabbing can reach
      const itemAtViewportStart = items[Math.round(vp.scrollLeft / ITEM_WIDTH)];
      expect(itemAtViewportStart?.hasAttribute("data-loop-clone")).toBe(false);
    });

    it("does not touch the scroll position while it is still moving", () => {
      vi.useFakeTimers();
      renderLoopCarousel();
      const vp = getViewport();
      const drifted = vp.scrollLeft + 600;
      vp.scrollLeft = drifted;
      fireEvent.scroll(vp);

      // teleporting mid-gesture cancels whatever the browser is animating, so
      // nothing may happen until the scroll has been quiet for a while
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY - 1);
      expect(vp.scrollLeft).toBe(drifted);
    });

    it("stays put when the scroll barely drifted from the original children", () => {
      vi.useFakeTimers();
      renderLoopCarousel();
      const vp = getViewport();
      const drifted = vp.scrollLeft + ITEM_WIDTH;
      vp.scrollLeft = drifted;
      fireEvent.scroll(vp);
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.scrollLeft).toBe(drifted);
    });

    it("wraps back towards the middle when scrolling close to the end", () => {
      renderLoopCarousel();
      const vp = getViewport();
      const maxScroll = vp.scrollWidth - vp.clientWidth;
      const beforeWrap = maxScroll - 10;
      vp.scrollLeft = beforeWrap;
      fireEvent.scroll(vp);

      const afterWrap = vp.scrollLeft;
      // it moved back far enough to have room to keep scrolling forwards
      expect(afterWrap).toBeLessThan(maxScroll - VIEWPORT_WIDTH);
      expect(afterWrap).toBeGreaterThan(VIEWPORT_WIDTH);
      // and it landed on a whole number of copies, so nothing moved on screen
      expect((beforeWrap - afterWrap) % NATURAL_WIDTH).toBe(0);
    });

    it("wraps forwards when scrolling close to the start", () => {
      renderLoopCarousel();
      const vp = getViewport();
      const maxScroll = vp.scrollWidth - vp.clientWidth;
      const beforeWrap = 10;
      vp.scrollLeft = beforeWrap;
      fireEvent.scroll(vp);

      const afterWrap = vp.scrollLeft;
      expect(afterWrap).toBeGreaterThan(VIEWPORT_WIDTH);
      expect(afterWrap).toBeLessThan(maxScroll - VIEWPORT_WIDTH);
      expect((afterWrap - beforeWrap) % NATURAL_WIDTH).toBe(0);
    });

    it("leaves the scroll position alone while it stays away from the ends", () => {
      renderLoopCarousel();
      const vp = getViewport();
      const middle = (vp.scrollWidth - vp.clientWidth) / 2;
      vp.scrollLeft = middle;
      fireEvent.scroll(vp);
      expect(vp.scrollLeft).toBe(middle);
    });

    /** Scrolls the wheel without going anywhere near the end of the content */
    const wheelInPlace = (vp: HTMLElement) => {
      fireEvent.wheel(vp, { deltaX: 120 });
      fireEvent.scroll(vp);
    };

    it("leaves the browser's own snapping alone for an ordinary wheel scroll", () => {
      vi.useFakeTimers();
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();

      // nothing has been disturbed, so the browser snaps this one itself
      wheelInPlace(vp);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
    });

    it("runs the whole wheel gesture unsnapped in Chromium", () => {
      vi.useFakeTimers();
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();
      // Chromium commits to a snap target when the gesture starts, so waiting
      // for a wrap to take snapping off it would already be too late
      Object.defineProperty(navigator, "userAgentData", {
        value: { brands: [{ brand: "Chromium", version: "140" }] },
        configurable: true,
      });

      wheelInPlace(vp);
      expect(vp.style.scrollSnapType).toBe("none");

      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
    });

    it("takes snapping over when a wrap disturbs a wheel scroll, and gives it back", () => {
      vi.useFakeTimers();
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();

      // a wheel scroll long enough to run out of content: the wrap moves the
      // ground under the browser, which leaves it steering towards a snap point
      // that is now a whole set of copies away
      fireEvent.wheel(vp, { deltaX: 120 });
      vp.scrollLeft = vp.scrollWidth - vp.clientWidth - 10;
      fireEvent.scroll(vp);
      expect(vp.style.scrollSnapType).toBe("none");

      // ...and it comes back once the scroll has been quiet long enough for the
      // momentum to be over
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
    });

    it("does not take snapping over from a wrap outside a wheel scroll", () => {
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();

      // no wheel gesture in flight, so nothing of the browser's to protect
      vp.scrollLeft = vp.scrollWidth - vp.clientWidth - 10;
      fireEvent.scroll(vp);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
    });

    it("leaves dragging to look after its own snapping", () => {
      vi.useFakeTimers();
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();
      fireEvent.wheel(vp, { deltaX: 120 });
      vp.scrollLeft = vp.scrollWidth - vp.clientWidth - 10;
      fireEvent.scroll(vp);
      expect(vp.style.scrollSnapType).toBe("none");

      // taking hold of the carousel hands the scroll over to the drag, which
      // turns snapping off while it runs and lands on a snap point by itself —
      // the wheel take-over has no business putting it back under it
      fireEvent.pointerDown(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 0,
      });
      fireEvent.scroll(vp);
      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.style.scrollSnapType).toBe("none");
    });

    it("keeps the snapping the user asked for through a wrap", () => {
      vi.useFakeTimers();
      renderLoopCarousel({ scrollSnapType: "x mandatory" });
      const vp = getViewport();
      vp.scrollLeft = vp.scrollWidth - vp.clientWidth - 10;
      fireEvent.scroll(vp);
      expect(vp.style.scrollSnapType).toBe("x mandatory");

      vi.advanceTimersByTime(SCROLL_IDLE_DELAY);
      expect(vp.style.scrollSnapType).toBe("x mandatory");
    });

    it("can always be scrolled both ways", async () => {
      renderLoopCarousel();
      const vp = getViewport();
      fireEvent.scroll(vp);
      await waitFor(() => {
        expect(vp.getAttribute("data-can-scroll")).toBe("both");
      });
      expect(
        (screen.getByRole("button", { name: "prev" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
      expect(
        (screen.getByRole("button", { name: "next" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  describe("non-mouse pointer input", () => {
    it("does not initiate drag on touch pointerDown", () => {
      renderCarousel();
      const vp = getViewport();

      fireEvent.pointerDown(vp, {
        pointerType: "touch",
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      });

      // Drag start sets overflow to 'hidden' as a side-effect; touch skips this
      expect(vp.style.overflowX).not.toBe("hidden");
    });

    it("mouse pointerDown sets overflow to hidden to lock out native wheel scroll during drag", () => {
      renderCarousel();
      const vp = getViewport();

      fireEvent.pointerDown(vp, {
        pointerType: "mouse",
        pointerId: 1,
        clientX: 0,
        clientY: 0,
      });

      expect(vp.style.overflowX).toBe("hidden");
    });
  });
});
