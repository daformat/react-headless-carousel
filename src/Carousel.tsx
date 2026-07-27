import {
  Children,
  cloneElement,
  type ComponentPropsWithoutRef,
  createContext,
  type CSSProperties,
  type ForwardedRef,
  forwardRef,
  Fragment,
  isValidElement,
  type ReactElement,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { MaybeNull, MaybeUndefined } from "./utils/maybe.js";

/**
 * Use a fixed frame duration so that we can accurately predict snapping and
 * other momentum-based calculations. This is an acceptable tradeoff, since
 * requestAnimationFrame frame duration is variable. Using a dynamic frame
 * duration compounds into missed snap points if the actual frame duration is
 * different from the one we use for calculations ahead of the animation
 * (velocity and deceleration factor adjustments to account for snapping).
 */
const FRAME_DURATION = 16;
const RUBBER_BAND_BOUNCE_COEFFICIENT = 40;
const MAX_DISTANCE_FOR_CLICK = 3;
/**
 * How many times the content is repeated when looping: one set before and one
 * set after the original children, so there is always something to scroll to on
 * both sides before we wrap back to the middle.
 */
const LOOP_SETS = 3;
/**
 * How many viewports a single set has to cover (the children are duplicated
 * until they do). Wrapping teleports the scroll position, which cancels whatever
 * the browser was animating and makes it repaint content it had not rasterized,
 * so we trade a bit of DOM for wraps that happen as rarely as possible: this
 * leaves a fling three viewports of room backwards and five forwards before it
 * can run out of content.
 */
const LOOP_RUNWAY = 3;
/**
 * How long without a scroll event counts as the scroll having settled.
 */
const SCROLL_IDLE_DELAY = 200;
const CSS_VARS = Object.freeze({
  fadeSize: "--carousel-fade-size",
  fadeOffsetBackwards: "--carousel-fade-offset-backwards",
  fadeOffsetForwards: "--carousel-fade-offset-forwards",
  overscrollTranslateX: "--carousel-overscroll-translate-x",
  remainingBackwards: "--carousel-remaining-backwards",
  remainingForwards: "--carousel-remaining-forwards",
  scrollMarginInline: "--carousel-scroll-margin-inline",
  viewportPaddingInlineStart: "--carousel-viewport-padding-inline-start",
  viewportPaddingInlineEnd: "--carousel-viewport-padding-inline-end",
  viewportPaddingBlockStart: "--carousel-viewport-padding-block-start",
  viewportPaddingBlockEnd: "--carousel-viewport-padding-block-end",
  contentPaddingInlineStart: "--carousel-content-padding-inline-start",
  contentPaddingInlineEnd: "--carousel-content-padding-inline-end",
  contentPaddingBlockStart: "--carousel-content-padding-block-start",
  contentPaddingBlockEnd: "--carousel-content-padding-block-end",
});

type ScrollState = {
  isDragging: boolean;
  isDispatchingClick: boolean;
  startX: number;
  scrollLeft: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  totalTraveledX: number;
  animationId: number | null;
  initialTarget: MaybeNull<EventTarget>;
  initialPointerPosition: MaybeNull<{
    x: number;
    y: number;
  }>;
  mouseDirection: number;
  lastPointerType: PointerEvent["pointerType"] | "";
  scrollSnapType: string;
  cachedScrollWidth: number;
  cachedOffsetWidth: number;
  /**
   * Set while we probe the browser for snap positions: probing moves the scroll
   * position around before restoring it, which must not be mistaken for the
   * user reaching the end of the looped content.
   */
  suppressLoopWrap: boolean;
  /**
   * Whether a pointer is currently down, whatever its type. A touch scroll is
   * driven by the finger, so the scroll can look idle while the gesture is very
   * much still going.
   */
  isPointerDown: boolean;
  /**
   * Whether snapping is currently turned off for the benefit of a wheel scroll,
   * and still owes the user an animation to the position it asks for.
   */
  isWheelSnapSuspended: boolean;
};

type ScrollIntoView = (
  target: HTMLElement,
  container: HTMLElement,
  direction: "forwards" | "backwards" | "nearest",
) => void;

type CarouselContext = {
  loop?: boolean;
  viewportRef?: RefObject<MaybeNull<HTMLElement>>;
  setViewportRef: (ref: RefObject<MaybeNull<HTMLElement>>) => void;
  scrollsBackwards: boolean;
  scrollsForwards: boolean;
  setScrollsBackwards: (scrollsBackwards: boolean) => void;
  setScrollsForwards: (scrollsForwards: boolean) => void;
  handleScrollToNext: () => void;
  handleScrollToPrev: () => void;
  scrollIntoView: ScrollIntoView;
  remainingForwards: React.RefObject<number>;
  remainingBackwards: React.RefObject<number>;
  setRemainingForwards: (remainingForwards: number) => void;
  setRemainingBackwards: (remainingBackwards: number) => void;
  scrollStateRef?: MaybeUndefined<RefObject<ScrollState>>;
  setScrollStateRef: (state: RefObject<ScrollState>) => void;
  boundaryOffset?:
    | { x: number; y: number }
    | ((root: HTMLElement) => { x: number; y: number });
  rootRef: RefObject<MaybeNull<HTMLElement>>;
  clearAnimation: () => void;
};

const CarouselContext = createContext<CarouselContext>({
  setViewportRef: () => {},
  setScrollsBackwards: () => {},
  setScrollsForwards: () => {},
  scrollsBackwards: false,
  scrollsForwards: false,
  remainingForwards: { current: 0 },
  remainingBackwards: { current: 0 },
  setRemainingForwards: () => {},
  setRemainingBackwards: () => {},
  setScrollStateRef: () => {},
  handleScrollToNext: () => {},
  handleScrollToPrev: () => {},
  scrollIntoView: () => {},
  rootRef: { current: null },
  clearAnimation: () => {},
});

const useCarouselContext = () => {
  const context = useContext(CarouselContext);
  if (!context) {
    throw new Error("useCarouselContext must be used within Carousel.Root");
  }
  return context;
};

/**
 * Default boundary offset accounts for the content fade size
 */
const defaultBoundaryOffset = (container: HTMLElement) => {
  const viewport = container.querySelector("[data-carousel-viewport]");
  if (viewport) {
    const computedStyle = getComputedStyle(viewport);
    const maskSize = computedStyle.getPropertyValue(CSS_VARS.fadeSize);
    const temp = document.createElement("div");
    temp.style.position = "absolute";
    temp.style.visibility = "hidden";
    temp.style.setProperty(CSS_VARS.fadeSize, maskSize);
    temp.style.width = `var(${CSS_VARS.fadeSize})`;
    document.body.appendChild(temp);
    const computed = getComputedStyle(temp);
    const fadeSize = parseFloat(computed.getPropertyValue("width"));
    temp.remove();
    return { x: fadeSize, y: 0 };
  }
  return { x: 0, y: 0 };
};

/**
 * Returns the element's left offset relative to the scroll container's content
 * coordinate space, regardless of intermediate offsetParent ancestors.
 */
const getOffsetLeft = (element: HTMLElement, container: HTMLElement): number =>
  element.getBoundingClientRect().left -
  container.getBoundingClientRect().left +
  container.scrollLeft;

type LoopMetrics = {
  /**
   * Distance between two consecutive copies of the children — gaps, margins and
   * any other spacing included. The content repeats itself every naturalWidth,
   * which makes it the period we can shift the scroll position by without the
   * user noticing anything.
   */
  naturalWidth: number;
  /**
   * Width of one of the LOOP_SETS rendered sets (a whole number of copies).
   * Also the scroll position of the first original child, since it opens the
   * middle set.
   */
  setWidth: number;
};

/**
 * Measures the repetition period of a looping carousel straight from the laid
 * out DOM. Every set holds the same markup, so both distances can be read from
 * the position of the items opening each repetition.
 */
const measureLoopMetrics = (container: HTMLElement): MaybeNull<LoopMetrics> => {
  const content = container.querySelector<HTMLElement>(
    ":scope [data-carousel-content]",
  );
  const childrenCount = Number(
    content?.getAttribute("data-carousel-loop-size") ?? 0,
  );
  if (!content || !childrenCount) {
    return null;
  }
  const items = content.children;
  // every set renders the same markup, so this always divides evenly
  if (!items.length || items.length % LOOP_SETS !== 0) {
    return null;
  }
  const itemsPerSet = items.length / LOOP_SETS;
  const first = items[0];
  const nextCopy = items[childrenCount];
  const nextSet = items[itemsPerSet];
  if (
    !(first instanceof HTMLElement) ||
    !(nextCopy instanceof HTMLElement) ||
    !(nextSet instanceof HTMLElement)
  ) {
    return null;
  }
  const firstLeft = getOffsetLeft(first, container);
  const naturalWidth = getOffsetLeft(nextCopy, container) - firstLeft;
  const setWidth = getOffsetLeft(nextSet, container) - firstLeft;
  if (naturalWidth <= 0 || setWidth <= 0) {
    return null;
  }
  return { naturalWidth, setWidth };
};

/**
 * Returns the multiple of the loop period that brings the given scroll position
 * back to the copy of the children the carousel calls home — the original ones,
 * which open the middle set. Since every copy is identical, shifting a scroll
 * position by that amount is visually undetectable; what it buys is a full set
 * of content to scroll through backwards and two forwards.
 *
 * Homing in on the originals rather than on the middle of the scrollable range
 * also means the children that are actually exposed to assistive technology are
 * the ones on screen whenever the carousel comes to a rest.
 */
const getLoopShift = (scrollLeft: number, metrics: LoopMetrics) =>
  Math.round((scrollLeft - metrics.setWidth) / metrics.naturalWidth) *
  metrics.naturalWidth;

/**
 * Chromium drives a wheel scroll towards the snap point it picked when the
 * gesture started, and holds on to that target across anything else that moves
 * the position — including the jump a looping carousel makes when it runs out of
 * content. It then scrolls all the way back to it, which is very much visible.
 * Firefox and Safari do not do this, so they are left alone.
 */
const getIsChromium = () => {
  if (typeof navigator === "undefined") {
    return false;
  }
  const brands = (
    navigator as Navigator & {
      userAgentData?: { brands?: { brand: string }[] };
    }
  ).userAgentData?.brands;
  return brands
    ? brands.some(({ brand }) => brand === "Chromium")
    : /Chrome|Chromium|Edg\/|OPR\//.test(navigator.userAgent) &&
        !/Firefox/.test(navigator.userAgent);
};

/**
 * Instantly jumps the scroll position, whatever `scroll-behavior` the page asked
 * for.
 *
 * Snapping is otherwise left alone: turning it off and back on around the jump
 * forces the browser to re-snap, and a browser asked to re-snap in the middle of
 * a fling picks its target from where that fling was heading — nowhere near
 * where we just moved to — which shows up as the carousel flying across its
 * whole content before settling. It does not need the help anyway: every
 * position we jump to sits a whole number of copies away from the one we left,
 * so it lines up with the snap points exactly the same way.
 *
 * `reselectSnapTarget` is for the one case where it does need the help: right
 * after the content changed shape, the browser still holds on to the item it had
 * snapped to and will scroll back to it wherever we go. Toggling snapping makes
 * it let go and pick the item we actually landed on.
 */
const setLoopScrollLeft = (
  container: HTMLElement,
  scrollLeft: number,
  { reselectSnapTarget = false }: { reselectSnapTarget?: boolean } = {},
) => {
  const scrollSnapType = container.style.scrollSnapType;
  if (reselectSnapTarget) {
    container.style.scrollSnapType = "none";
  }
  container.scrollTo({ left: scrollLeft, behavior: "instant" });
  if (reselectSnapTarget) {
    container.style.scrollSnapType = scrollSnapType;
  }
};

/**
 * Takes the scroll position back home — onto the original children — and returns
 * the delta it applied. This is what tops the content back up on both sides so
 * the carousel can keep being scrolled in either direction, and it is free as
 * long as nothing is moving: the content repeats, so the same pixels stay on
 * screen, and a resting position stays snapped exactly where the user left it.
 *
 * Doing it while the browser is animating a scroll would cancel that animation,
 * so callers are expected to only do it once things have settled.
 */
const recenterLoopScroll = (container: HTMLElement) => {
  const metrics = measureLoopMetrics(container);
  if (!metrics) {
    return 0;
  }
  const scrollLeft = container.scrollLeft;
  // No need to move for every little scroll: home has a whole set of content
  // behind it and two ahead, so letting the carousel drift a quarter of a set
  // still leaves the tighter side of it more than two viewports to scroll.
  if (Math.abs(scrollLeft - metrics.setWidth) <= metrics.setWidth / 4) {
    return 0;
  }
  const shift = getLoopShift(scrollLeft, metrics);
  if (!shift) {
    return 0;
  }
  setLoopScrollLeft(container, scrollLeft - shift, {
    reselectSnapTarget: true,
  });
  return container.scrollLeft - scrollLeft;
};

type CarouselRootProps = {
  loop?: boolean;
  boundaryOffset?:
    | { x: number; y: number }
    | ((root: HTMLElement) => { x: number; y: number });
} & ComponentPropsWithoutRef<"div">;

const CarouselRoot = forwardRef<HTMLDivElement, CarouselRootProps>(
  (
    { boundaryOffset = defaultBoundaryOffset, loop = true, children, ...props },
    forwardedRef,
  ) => {
    const [viewportRef, setViewportRef] = useState<
      RefObject<MaybeNull<HTMLElement>>
    >({
      current: null,
    });
    const [scrollsBackwards, setScrollsBackwards] = useState(false);
    const [scrollsForwards, setScrollsForwards] = useState(false);
    const remainingForwards = useRef(0);
    const remainingBackwards = useRef(0);
    const setRemainingForwards = useCallback((value: number) => {
      remainingForwards.current = value;
    }, []);
    const setRemainingBackwards = useCallback((value: number) => {
      remainingBackwards.current = value;
    }, []);
    const [scrollStateRef, setScrollStateRef] =
      useState<MaybeUndefined<RefObject<ScrollState>>>(undefined);
    const rootRef = useRef<HTMLDivElement>(null);

    /**
     * Clears the current animation and resets animation styling
     */
    const clearAnimation = useCallback(() => {
      const state = scrollStateRef?.current;
      if (!state) {
        return;
      }
      const animationId = state.animationId;
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
      // this is a ref, although it's in a state to be able to pass it around,
      // it is safe to mutate it, using the setter would cause unwanted re-renders
      // eslint-disable-next-line react-hooks/immutability
      state.animationId = null;
      state.velocityX = 0;
      const container = viewportRef.current;
      if (!container) {
        return;
      }
      // dragging and momentum turn snapping off while they run, give the user
      // back the snapping they asked for now that nothing is animating
      container.style.scrollSnapType = state.scrollSnapType;
      container.style.removeProperty(CSS_VARS.overscrollTranslateX);
      const allItems = container.querySelectorAll(
        ":scope [data-carousel-content] > *",
      );
      allItems.forEach((item) => {
        if (item instanceof HTMLElement) {
          item.style.translate = "";
        }
      });
    }, [viewportRef, scrollStateRef]);

    /**
     * Scroll the whole page (the container client width)
     */
    const handleScrollPage = useCallback(
      (
        direction: "forwards" | "backwards",
        container: HTMLElement,
        items: HTMLElement[],
      ) => {
        const currentScroll = container.scrollLeft;
        const offset = rootRef.current
          ? getBoundaryOffset(boundaryOffset, rootRef.current).x
          : 0;
        let delta =
          (container.clientWidth - offset * 2) *
          (direction === "forwards" ? 1 : -1);
        // If multiple items, we can be more precise and scroll so the next / prev
        // item that is not fully visible becomes fully visible after page scroll.
        if (items.length > 1) {
          if (direction === "forwards") {
            const nextItem = items.find(
              (item) =>
                getOffsetLeft(item, container) + item.offsetWidth >
                currentScroll + container.offsetWidth - offset,
            );
            if (
              nextItem &&
              nextItem.offsetWidth < container.offsetWidth - offset * 2
            ) {
              delta =
                getOffsetLeft(nextItem, container) -
                container.scrollLeft -
                offset;
            }
          } else {
            const prevItem = items
              .filter(
                (item) =>
                  getOffsetLeft(item, container) < currentScroll + offset,
              )
              .reverse()[0];
            if (
              prevItem &&
              prevItem.offsetWidth < container.offsetWidth - offset * 2
            ) {
              delta =
                container.scrollLeft -
                getOffsetLeft(prevItem, container) -
                container.offsetWidth -
                offset;
            }
          }
        }
        const scrollPosition = currentScroll + delta;
        const maxScroll = container.scrollWidth - container.clientWidth;
        const nextScrollPosition = Math.max(
          0,
          Math.min(scrollPosition, maxScroll),
        );
        container.scrollTo({ left: nextScrollPosition, behavior: "smooth" });
      },
      [boundaryOffset],
    );

    /**
     * Snaps the desired scroll according to the selected snapping qnd returns
     * the snapped scroll position
     */
    const snapScroll = useCallback(
      (targetScroll: number, container: HTMLElement) => {
        const state = scrollStateRef?.current;
        const currentScroll = container.scrollLeft;
        if (state) {
          // this is a ref, although it's in a state to be able to pass it around,
          // it is safe to mutate it, using the setter would cause unwanted re-renders
          // eslint-disable-next-line react-hooks/immutability
          state.suppressLoopWrap = true;
        }
        container.style.scrollSnapType = state?.scrollSnapType ?? "";
        container.scrollTo({ left: targetScroll, behavior: "instant" });
        const snappedScrollPosition = container.scrollLeft;
        container.scrollTo({ left: currentScroll, behavior: "instant" });
        if (state) {
          state.suppressLoopWrap = false;
        }
        return snappedScrollPosition;
      },
      [scrollStateRef],
    );

    /**
     * Scroll to the target scroll or to the closest snapped position
     */
    const snappedScrollTo = useCallback(
      (
        targetScroll: number,
        container: HTMLElement,
        behavior: ScrollToOptions["behavior"] = "smooth",
      ) => {
        const snappedScroll = snapScroll(targetScroll, container);
        // request animation frame to prevent Safari from being Safari
        requestAnimationFrame(() => {
          container.scrollTo({
            left: snappedScroll,
            behavior,
          });
        });
      },
      [snapScroll],
    );

    /**
     * Custom scrollIntoViewNearest to prevent ancestors scrolling when doing
     * native element.scrollIntoView()
     */
    const scrollIntoViewNearest = useCallback(
      (target: HTMLElement, container: HTMLElement) => {
        const offset = rootRef.current
          ? getBoundaryOffset(boundaryOffset, rootRef.current).x
          : 0;
        const getIsBeforeAfter = () => {
          const targetLeft = getOffsetLeft(target, container);
          const isBefore = targetLeft < container.scrollLeft + offset;
          const isAfter =
            targetLeft + target.offsetWidth >
            container.scrollLeft + container.offsetWidth - offset;
          return { isBefore, isAfter };
        };
        let { isBefore, isAfter } = getIsBeforeAfter();
        // Default when the target is larger than the container
        if (isBefore && isAfter) {
          const scrollPosition = getOffsetLeft(target, container) - offset;
          container.scrollTo({
            left: scrollPosition <= offset ? 0 : scrollPosition,
            behavior: "smooth",
          });
        } else if (isBefore || isAfter) {
          const currentScroll = container.scrollLeft;
          const targetLeft = getOffsetLeft(target, container);
          let scrollPosition = isBefore
            ? targetLeft - offset
            : targetLeft - container.offsetWidth + target.offsetWidth + offset;
          let iterations = 0;
          const maxIterations = 20;
          // Adjust scroll position to account for snapping, if the target is
          // still before or after, we increment / decrement the scroll position
          const state = scrollStateRef?.current;
          if (state) {
            // this is a ref, although it's in a state to be able to pass it around,
            // it is safe to mutate it, using the setter would cause unwanted re-renders
            // eslint-disable-next-line react-hooks/immutability
            state.suppressLoopWrap = true;
          }
          container.style.scrollSnapType = state?.scrollSnapType ?? "";
          while (
            scrollPosition > 0 &&
            scrollPosition < container.scrollWidth - container.offsetWidth &&
            (isBefore || isAfter) &&
            iterations < maxIterations
          ) {
            container.scrollTo({
              left: scrollPosition <= offset ? 0 : scrollPosition,
              behavior: "instant",
            });
            const newState = getIsBeforeAfter();
            isBefore = newState.isBefore;
            isAfter = newState.isAfter;
            if (isBefore) {
              scrollPosition -= target.offsetWidth / 2;
            } else if (isAfter) {
              scrollPosition += target.offsetWidth / 2;
            }
            iterations++;
          }
          container.scrollTo({ left: currentScroll, behavior: "instant" });
          if (state) {
            state.suppressLoopWrap = false;
          }
          snappedScrollTo(
            scrollPosition <= offset ? 0 : scrollPosition,
            container,
          );
        }
      },
      [boundaryOffset, scrollStateRef, snappedScrollTo],
    );

    /**
     * Custom scrollIntoView to prevent ancestors scrolling when doing native
     * element.scrollIntoView()
     */
    const scrollIntoView = useCallback<ScrollIntoView>(
      (target, container, direction) => {
        clearAnimation();
        const [_, inline] = getScrollSnapAlign(getComputedStyle(target));
        if (direction === "nearest") {
          scrollIntoViewNearest(target, container);
          return;
        }
        const offset = rootRef.current
          ? getBoundaryOffset(boundaryOffset, rootRef.current).x
          : 0;
        const targetLeft = getOffsetLeft(target, container);
        let scrollPosition =
          direction === "forwards"
            ? targetLeft - offset
            : targetLeft - container.offsetWidth + target.offsetWidth + offset;
        if (inline === "center") {
          scrollPosition =
            targetLeft - (container.offsetWidth - target.offsetWidth) / 2;
        }
        snappedScrollTo(scrollPosition, container);
      },
      [boundaryOffset, clearAnimation, scrollIntoViewNearest, snappedScrollTo],
    );

    /**
     * Scrolls the container to the next slide until hitting the end of the container
     */
    const handleScrollToNext = useCallback(() => {
      clearAnimation();
      const container = viewportRef?.current;
      const root = rootRef?.current;
      if (root && container && container.scrollLeft < container.scrollWidth) {
        // this is a ref, although it's in a state to be able to pass it around,
        // it is safe to mutate it, using the setter would cause unwanted re-renders
        // eslint-disable-next-line react-hooks/immutability
        container.style.scrollSnapType =
          scrollStateRef?.current?.scrollSnapType ?? "";
        if (loop) {
          // start from the middle of the repeated content, so the scroll we are
          // about to animate cannot run out of content and be cut short by a wrap
          recenterLoopScroll(container);
        }
        const items = Array.from(
          container.querySelectorAll(":scope [data-carousel-content] > *"),
        ) as HTMLElement[];
        if (items.length === 1) {
          handleScrollPage("forwards", container, items);
          return;
        }
        const currentScroll = container.scrollLeft;
        const containerOffsetWidth = container.offsetWidth;
        const { x: boundaryOffsetX } = getBoundaryOffset(boundaryOffset, root);
        const isNextItem = (item: HTMLElement) => {
          return (
            getOffsetLeft(item, container) + item.offsetWidth >
            Math.ceil(currentScroll + containerOffsetWidth - boundaryOffsetX)
          );
        };
        const nextItem = items.find(isNextItem) ?? items[items.length - 1];
        if (nextItem) {
          if (
            nextItem.offsetWidth >=
            container.offsetWidth - boundaryOffsetX * 2
          ) {
            handleScrollPage("forwards", container, items);
          } else {
            scrollIntoView(nextItem, container, "forwards");
          }
        }
      }
    }, [
      boundaryOffset,
      clearAnimation,
      handleScrollPage,
      loop,
      viewportRef,
      scrollIntoView,
      scrollStateRef,
    ]);

    /**
     * Scrolls the container to the previous slide until hitting the start of the container
     */
    const handleScrollToPrev = useCallback(() => {
      clearAnimation();
      const container = viewportRef?.current;
      const root = rootRef?.current;
      // when looping there is always something before the current position
      if (root && container && (loop || container.scrollLeft > 0)) {
        // this is a ref, although it's in a state to be able to pass it around,
        // it is safe to mutate it, using the setter would cause unwanted re-renders
        // eslint-disable-next-line react-hooks/immutability
        container.style.scrollSnapType =
          scrollStateRef?.current?.scrollSnapType ?? "";
        if (loop) {
          // start from the middle of the repeated content, so the scroll we are
          // about to animate cannot run out of content and be cut short by a wrap
          recenterLoopScroll(container);
        }
        const items = Array.from(
          container.querySelectorAll(":scope [data-carousel-content] > *"),
        ) as HTMLElement[];
        if (items.length === 1) {
          handleScrollPage("backwards", container, items);
          return;
        }
        const currentScroll = container.scrollLeft;
        const { x: boundaryOffsetX } = getBoundaryOffset(boundaryOffset, root);
        const isPrevItem = (item: HTMLElement) => {
          return (
            currentScroll > getOffsetLeft(item, container) - boundaryOffsetX
          );
        };
        const prevItems = items.filter(isPrevItem);
        const prevItem = prevItems[prevItems.length - 1] ?? items[0];
        if (prevItem) {
          if (
            prevItem.offsetWidth >=
            container.offsetWidth - boundaryOffsetX * 2
          ) {
            handleScrollPage("backwards", container, items);
          } else {
            scrollIntoView(prevItem, container, "backwards");
          }
        }
      }
    }, [
      boundaryOffset,
      clearAnimation,
      handleScrollPage,
      loop,
      viewportRef,
      scrollIntoView,
      scrollStateRef,
    ]);

    const carouselContext = useMemo<CarouselContext>(() => {
      return {
        loop,
        viewportRef,
        setViewportRef,
        scrollsBackwards,
        scrollsForwards,
        setScrollsBackwards,
        setScrollsForwards,
        remainingForwards,
        remainingBackwards,
        setRemainingForwards,
        setRemainingBackwards,
        scrollStateRef,
        setScrollStateRef,
        handleScrollToNext,
        handleScrollToPrev,
        scrollIntoView,
        clearAnimation,
        boundaryOffset,
        rootRef,
      };
    }, [
      viewportRef,
      loop,
      scrollsBackwards,
      scrollsForwards,
      setRemainingForwards,
      setRemainingBackwards,
      scrollStateRef,
      handleScrollToNext,
      handleScrollToPrev,
      scrollIntoView,
      clearAnimation,
      boundaryOffset,
    ]);

    useEffect(() => {
      return clearAnimation;
    }, [clearAnimation]);

    return (
      <CarouselContext.Provider value={carouselContext}>
        <div ref={combineRefs(rootRef, forwardedRef)} {...props}>
          {children}
        </div>
      </CarouselContext.Provider>
    );
  },
);

CarouselRoot.displayName = "Carousel.Root";

type CarouselViewportBaseProps = ComponentPropsWithoutRef<"div"> & {
  scrollSnapType?: CSSProperties["scrollSnapType"];
};

type CarouselViewportProps = CarouselViewportBaseProps &
  (
    | {
        contentFade?: true;
        contentFadeSize?: string | number;
      }
    | {
        contentFade: false;
        contentFadeSize?: never;
      }
  );

const CarouselViewport = forwardRef<HTMLDivElement, CarouselViewportProps>(
  (
    {
      children,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onClickCapture,
      onWheel,
      contentFade = true,
      contentFadeSize = "clamp(16px, 10vw, 64px)",
      scrollSnapType,
      style,
      className,
      ...props
    },
    forwardedRef,
  ) => {
    const {
      loop,
      setViewportRef,
      setScrollsBackwards,
      setScrollsForwards,
      scrollsForwards,
      scrollsBackwards,
      scrollIntoView,
      setRemainingForwards,
      setRemainingBackwards,
      setScrollStateRef,
      clearAnimation,
      boundaryOffset,
      rootRef,
    } = useContext(CarouselContext);
    const viewportRef = useRef<HTMLDivElement>(null);
    const scrollStateRef = useRef<ScrollState>({
      isDragging: false,
      isDispatchingClick: false,
      startX: 0,
      scrollLeft: 0,
      lastX: 0,
      lastTime: 0,
      velocityX: 0,
      totalTraveledX: 0,
      animationId: null as number | null,
      initialTarget: null as MaybeNull<EventTarget>,
      initialPointerPosition: null as MaybeNull<{ x: number; y: number }>,
      mouseDirection: 0,
      lastPointerType: "",
      scrollSnapType: scrollSnapType ?? "",
      cachedScrollWidth: 0,
      cachedOffsetWidth: 0,
      suppressLoopWrap: false,
      isPointerDown: false,
      isWheelSnapSuspended: false,
    });
    const loopMetricsRef = useRef<MaybeNull<LoopMetrics>>(null);

    // Keep the ref in sync with the prop on every render so event handlers
    // always see the current value without needing a layout effect.
    // eslint-disable-next-line react-hooks/refs
    scrollStateRef.current.scrollSnapType = scrollSnapType ?? "";

    /**
     * Register our refs; Layout effect to make sure we render the arrows
     * or the content-fade in the initial frame
     */
    useLayoutEffect(() => {
      setViewportRef(viewportRef);
      setScrollStateRef(scrollStateRef);
    }, [setViewportRef, setScrollStateRef]);

    /**
     * Determine whether the container can scroll forwards or backwards based on
     * its current scroll position, offset width, and scroll width. Updates
     * relevant state and CSS variables.
     */
    const updateScrollState = useCallback(() => {
      const container = viewportRef.current;
      const root = rootRef.current;
      if (container && root) {
        const translateX = Math.ceil(
          parseFloat(
            container.style.getPropertyValue(CSS_VARS.overscrollTranslateX) ??
              "0",
          ),
        );
        const containerScrollWidth =
          (container.scrollWidth ?? 0) - (translateX > 0 ? translateX : 0);
        const containerOffsetWidth = container.offsetWidth ?? 0;
        const containerScrollLeft = container.scrollLeft ?? 0;
        scrollStateRef.current.cachedScrollWidth = containerScrollWidth;
        scrollStateRef.current.cachedOffsetWidth = containerOffsetWidth;
        if (!container || containerScrollWidth <= containerOffsetWidth) {
          setScrollsBackwards(false);
          setScrollsForwards(false);
        } else if (loop) {
          // a looping carousel never runs out of content on either side
          setScrollsBackwards(true);
          setScrollsForwards(true);
        } else if (containerScrollLeft <= 0) {
          setScrollsBackwards(false);
          setScrollsForwards(true);
        } else if (
          Math.ceil(containerScrollLeft) <
          containerScrollWidth - containerOffsetWidth - 1
        ) {
          setScrollsBackwards(true);
          setScrollsForwards(true);
        } else {
          setScrollsBackwards(true);
          setScrollsForwards(false);
        }
        const remainingBackwards = containerScrollLeft;
        const remainingForwards =
          containerScrollWidth - containerScrollLeft - containerOffsetWidth;
        setRemainingForwards(remainingForwards);
        setRemainingBackwards(remainingBackwards);
        const { x: offsetX } = getBoundaryOffset(boundaryOffset, root);
        root.style.setProperty(CSS_VARS.scrollMarginInline, `${offsetX}px`);
        root.style.setProperty(
          CSS_VARS.remainingForwards,
          `${remainingForwards}px`,
        );
        root.style.setProperty(
          CSS_VARS.remainingBackwards,
          `${remainingBackwards}px`,
        );
      }
    }, [
      rootRef,
      boundaryOffset,
      loop,
      setRemainingBackwards,
      setRemainingForwards,
      setScrollsBackwards,
      setScrollsForwards,
    ]);

    /**
     * Returns the repetition period of the looped content, measuring it again
     * whenever the content or the viewport changed since the last measure.
     */
    const getLoopMetrics = useCallback(() => {
      const container = viewportRef.current;
      if (!loop || !container) {
        return null;
      }
      if (!loopMetricsRef.current) {
        loopMetricsRef.current = measureLoopMetrics(container);
      }
      return loopMetricsRef.current;
    }, [loop]);

    /**
     * Last resort: teleports the scroll position back home when it comes within
     * a viewport of either end, so that a gesture long enough to eat through the
     * whole runway still cannot reach the end of the content. Both the position
     * we leave and the one we land on show the exact same pixels, so the jump
     * itself cannot be seen, but it does cut short whatever the browser was
     * animating — hence keeping it for the cases the settled recentering below
     * could not prevent. Returns the applied delta.
     */
    const wrapLoopScroll = useCallback(() => {
      const container = viewportRef.current;
      const state = scrollStateRef.current;
      const metrics = getLoopMetrics();
      if (!container || !metrics || state.suppressLoopWrap) {
        return 0;
      }
      const margin = container.clientWidth;
      const maxScroll = container.scrollWidth - container.clientWidth;
      const scrollLeft = container.scrollLeft;
      if (
        maxScroll <= margin * 2 ||
        (scrollLeft > margin && scrollLeft < maxScroll - margin)
      ) {
        return 0;
      }
      const shift = getLoopShift(scrollLeft, metrics);
      if (!shift) {
        return 0;
      }
      // The item the browser had snapped to is now a whole set of copies away
      // from the viewport. Left alone it holds on to it and, the next time it
      // gets to snap, scrolls all the way back to it — content flying past for
      // hundreds of milliseconds. Making it re-pick from where we land keeps it
      // on the copy the user is actually looking at.
      setLoopScrollLeft(container, scrollLeft - shift, {
        reselectSnapTarget: true,
      });
      // the drag and momentum baselines track the scroll position themselves,
      // teleport them along with it
      const delta = container.scrollLeft - scrollLeft;
      state.scrollLeft += delta;
      return delta;
    }, [getLoopMetrics]);

    /**
     * Recenters the looped content once everything has come to a stop. This is
     * where most of the wrapping happens: doing it here costs nothing, whereas
     * teleporting mid-scroll cancels whatever the browser was animating — a
     * snap, a smooth scroll — and reads as the carousel stuttering or ignoring
     * a click.
     */
    const settleLoopScroll = useCallback(() => {
      const container = viewportRef.current;
      const state = scrollStateRef.current;
      if (
        !loop ||
        !container ||
        state.suppressLoopWrap ||
        state.isDragging ||
        state.isPointerDown ||
        // our own momentum is still running the show
        state.animationId !== null
      ) {
        return;
      }
      loopMetricsRef.current = null;
      state.scrollLeft += recenterLoopScroll(container);
    }, [loop]);

    /**
     * Asks the browser where it would snap to from where we are, without
     * actually going there. Snapping is left off, the way the wheel scroll wants
     * it — settleWheelSnap hands it back when it is done.
     */
    const getSnapPosition = useCallback((container: HTMLElement) => {
      const state = scrollStateRef.current;
      const scrollLeft = container.scrollLeft;
      state.suppressLoopWrap = true;
      container.style.scrollSnapType = state.scrollSnapType;
      // a scroll has to actually go somewhere for the browser to snap it
      container.scrollTo({ left: scrollLeft + 1, behavior: "instant" });
      const snapped = container.scrollLeft;
      container.style.scrollSnapType = "none";
      container.scrollTo({ left: scrollLeft, behavior: "instant" });
      state.suppressLoopWrap = false;
      return snapped;
    }, []);

    /**
     * Gives back the snapping a wheel scroll had turned off, once that scroll
     * has come to a stop: the carousel animates to the position the user's
     * snapping asks for, and only then does the browser get to snap again.
     * Animating it ourselves is the point — the browser would otherwise do it
     * against the momentum it is still running, or against a target it picked
     * before the carousel wrapped.
     */
    const settleWheelSnap = useCallback(() => {
      const container = viewportRef.current;
      const state = scrollStateRef.current;
      if (
        !container ||
        !state.isWheelSnapSuspended ||
        state.isDragging ||
        state.isPointerDown ||
        // a momentum of ours lands on a snap point by itself
        state.animationId !== null
      ) {
        return;
      }
      const scrollLeft = container.scrollLeft;
      const snapped = getSnapPosition(container);
      if (Math.abs(snapped - scrollLeft) > 1) {
        // still snapping off, so nothing pulls at the animation. It scrolls,
        // which brings us back here once it in turn goes quiet.
        container.scrollTo({ left: snapped, behavior: "smooth" });
        return;
      }
      state.isWheelSnapSuspended = false;
      // We are on the snap point already. Writing the position one last time
      // before handing snapping back is what makes the browser adopt the item
      // we are on rather than the one it was holding on to.
      container.scrollTo({ left: scrollLeft, behavior: "instant" });
      container.style.scrollSnapType = state.scrollSnapType;
    }, [getSnapPosition]);

    /**
     * Prevent native scroll when dragging
     */
    const preventWheelScroll = useCallback((event: WheelEvent) => {
      event.preventDefault();
    }, []);

    /**
     * Initialize dragging.
     */
    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        scrollStateRef.current.lastPointerType = event.pointerType;
        scrollStateRef.current.isPointerDown = true;
        // dragging looks after its own snapping, from here on the wheel has no
        // say in it
        scrollStateRef.current.isWheelSnapSuspended = false;
        if (event.pointerType !== "mouse" || event.button !== 0) {
          return;
        }
        event.currentTarget.setPointerCapture?.(event.pointerId);

        const state = scrollStateRef.current;
        if (state.animationId !== null) {
          cancelAnimationFrame(state.animationId);
          state.animationId = null;
        }

        const container = viewportRef.current;
        if (!container) {
          return;
        }

        container.addEventListener("wheel", preventWheelScroll, {
          passive: false,
        });
        container.style.overflowX = "hidden";
        state.cachedScrollWidth = container.scrollWidth;
        state.cachedOffsetWidth = container.offsetWidth;
        state.isDragging = true;
        state.startX = event.clientX;
        state.lastX = event.clientX;
        state.scrollLeft = container.scrollLeft ?? 0;
        state.lastTime = Date.now();
        state.velocityX = 0;
        state.totalTraveledX = 0;
        state.initialTarget = event.target;
        state.initialPointerPosition = { x: event.clientX, y: event.clientY };
        event.preventDefault();
        event.stopPropagation();
        onPointerDown?.(event);
      },
      [onPointerDown, preventWheelScroll],
    );

    /**
     * Prevent velocity from exceeding a given threshold.
     */
    const clampVelocity = useCallback((maxAbsoluteVelocity: number) => {
      const state = scrollStateRef.current;
      if (Math.abs(state.velocityX) > maxAbsoluteVelocity) {
        state.velocityX = Math.sign(state.velocityX) * maxAbsoluteVelocity;
      }
    }, []);

    /**
     * Calculate rubber banding effect, translate carousel items, and update
     * velocity accordingly.
     */
    const applyRubberBanding = useCallback(
      (container: HTMLDivElement, scrollDelta: number) => {
        const state = scrollStateRef.current;
        const items = container.querySelectorAll(
          ":scope [data-carousel-content] > *",
        );
        const maxDistance = state.cachedOffsetWidth / 3;
        const maxScrollLeft = state.cachedScrollWidth - state.cachedOffsetWidth;
        const targetScrollLeft = state.scrollLeft + scrollDelta;
        const overscroll =
          targetScrollLeft < 0
            ? Math.abs(targetScrollLeft)
            : targetScrollLeft > maxScrollLeft
              ? targetScrollLeft - maxScrollLeft
              : 0;
        const sign = Math.sign(scrollDelta);
        const easedDistance = iOSRubberBand(overscroll, 0, maxDistance);
        container.style.setProperty(
          CSS_VARS.overscrollTranslateX,
          `${-sign * easedDistance}px`,
        );
        items.forEach((item) => {
          // we have to translate the items instead of the content because
          // Safari scrolls the viewport if the content is translated
          if (item instanceof HTMLElement) {
            item.style.translate = `var(${CSS_VARS.overscrollTranslateX}) 0`;
          }
        });

        state.velocityX =
          -sign *
          Math.max(
            easedDistance / RUBBER_BAND_BOUNCE_COEFFICIENT,
            Math.abs(state.velocityX),
          );
      },
      [],
    );

    /**
     * Update scroll position and velocity on pointer move.
     */
    const handlePointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const container = viewportRef.current;
        const state = scrollStateRef.current;
        const maxAbsoluteVelocity = 15;
        if (!state.isDragging || !container || event.pointerType !== "mouse") {
          onPointerMove?.(event);
          return;
        }

        container.style.scrollSnapType = "none";
        const currentTime = Date.now();
        const deltaTime = currentTime - state.lastTime;
        const deltaX = event.clientX - state.lastX;
        state.totalTraveledX += Math.abs(deltaX);
        if (deltaTime > 0) {
          state.velocityX = deltaX / deltaTime; // (pixels per millisecond)
          clampVelocity(maxAbsoluteVelocity);
        }

        const scrollDelta = state.startX - event.clientX;
        const direction = Math.sign(state.startX - event.clientX);
        if (direction !== state.mouseDirection) {
          state.mouseDirection = direction;
        }
        container.scrollLeft = state.scrollLeft + scrollDelta;
        // wrap right away rather than waiting for the scroll event, so the next
        // move is computed from the position we actually ended up on
        wrapLoopScroll();
        state.lastX = event.clientX;
        state.lastTime = currentTime;

        // a looping carousel has no boundary to bounce against
        if (
          !loop &&
          (container.scrollLeft <= 1 ||
            container.scrollLeft >=
              container.scrollWidth - container.offsetWidth - 1)
        ) {
          applyRubberBanding(container, scrollDelta);
          clampVelocity(maxAbsoluteVelocity);
        }
        onPointerMove?.(event);
      },
      [applyRubberBanding, clampVelocity, loop, onPointerMove, wrapLoopScroll],
    );

    /**
     * Updates velocity for proper snapping and returns the adjusted deceleration
     * factor. Ensures the animation lands on the snap point and is visually
     * perceptible.
     */
    const applyMomentumSnapping = useCallback(
      (
        container: HTMLDivElement,
        initialScroll: number,
        tFinalScroll: number,
        decelerationFactor: number,
        minVelocity: number,
      ) => {
        const state = scrollStateRef.current;

        // Find where the browser would snap to at tFinalScroll. When looping,
        // the momentum can aim past the rendered content: probing an equivalent
        // in-range position gives the same answer, one period away.
        const metrics = getLoopMetrics();
        const probeShift = metrics ? getLoopShift(tFinalScroll, metrics) : 0;
        state.suppressLoopWrap = true;
        container.style.scrollSnapType = state.scrollSnapType;
        container.scrollLeft = tFinalScroll - probeShift;
        const snappedScroll = container.scrollLeft + probeShift;
        container.style.scrollSnapType = "none";
        container.scrollLeft = initialScroll;
        state.suppressLoopWrap = false;

        const { finalScroll, iterations } = getFinalScroll(
          initialScroll,
          state.velocityX,
          decelerationFactor,
          minVelocity,
        );

        // update velocity to ensure momentum snaps to the correct position and
        // the animation is not too fast
        const minIterations = 10;
        const gap = snappedScroll - finalScroll;
        if (
          !isFinite(iterations) ||
          iterations < minIterations ||
          Math.abs(gap) > 0.5
        ) {
          const displacement = snappedScroll - initialScroll;
          state.velocityX =
            (-displacement * (1 - decelerationFactor)) /
            (FRAME_DURATION *
              (1 - Math.pow(decelerationFactor, minIterations)));
        }

        return findDecelerationFactor(
          initialScroll,
          snappedScroll,
          state.velocityX,
        );
      },
      [getLoopMetrics],
    );

    /**
     * Returns the deceleration factor for the momentum animation, accounting for
     * snapping if needed.
     */
    const computeMomentumDecelerationFactor = useCallback(
      (container: HTMLDivElement, minVelocity: number) => {
        const minVelocityForSnapping = 0;
        const state = scrollStateRef.current;
        // a looping carousel has no boundary to bounce against
        const isRubberBanding =
          !loop &&
          (container.scrollLeft <= 1 ||
            container.scrollLeft >=
              state.cachedScrollWidth - state.cachedOffsetWidth - 1);
        const rubberBandingFactor = isRubberBanding
          ? (state.velocityX * 25) / state.cachedScrollWidth
          : 0;
        const friction = 0.05 + Math.abs(rubberBandingFactor);
        const decelerationFactor = 1 - friction;
        const initialScroll = container.scrollLeft;
        const { finalScroll } = getFinalScroll(
          initialScroll,
          state.velocityX,
          decelerationFactor,
          minVelocity,
        );

        if (
          // when looping, the momentum always lands on a snap point: the
          // content repeats, so there is no end of the list to run into
          (loop ||
            (!isRubberBanding &&
              finalScroll < state.cachedScrollWidth - state.cachedOffsetWidth &&
              finalScroll > 0)) &&
          Math.abs(state.velocityX) >= minVelocityForSnapping &&
          state.scrollSnapType
        ) {
          return applyMomentumSnapping(
            container,
            initialScroll,
            finalScroll,
            decelerationFactor,
            minVelocity,
          );
        }

        return decelerationFactor;
      },
      [applyMomentumSnapping, loop],
    );

    /**
     * Start the momentum animation if needed.
     */
    const startMomentumAnimation = useCallback(() => {
      const container = viewportRef.current;
      if (!container) {
        return;
      }
      const state = scrollStateRef.current;
      state.cachedScrollWidth = container.scrollWidth;
      state.cachedOffsetWidth = container.offsetWidth;
      state.scrollLeft = container.scrollLeft;
      const minVelocity = 0.00001;
      const decelerationFactor = computeMomentumDecelerationFactor(
        container,
        minVelocity,
      );
      const animate = () => {
        const container2 = viewportRef.current;
        if (!container2) {
          return;
        }

        container2.style.scrollSnapType = "none";
        // this is important: since some browsers (hem, Safari, **cough cough**)
        // round the DOM scrollLeft property, we have to keep our own state in
        // order for the final scroll not to drift from the predicted value
        state.scrollLeft -= state.velocityX * FRAME_DURATION;
        container2.scrollLeft = state.scrollLeft;
        // keeps state.scrollLeft in sync with the position we land on, so the
        // momentum carries on across the jump
        wrapLoopScroll();
        state.velocityX *= decelerationFactor;

        const newScrollLeft = state.scrollLeft;
        const scrollWidth = state.cachedScrollWidth;
        const offsetWidth = state.cachedOffsetWidth;
        const remainingForwards = scrollWidth - offsetWidth - newScrollLeft;
        const remainingBackwards = newScrollLeft;

        // Overscroll rubber band bounce-back (a looping carousel never reaches
        // either end, there is nothing to bounce against)
        if (
          !loop &&
          Math.abs(state.velocityX) > minVelocity &&
          (remainingForwards <= 1 || remainingBackwards < 1)
        ) {
          const content = container2.querySelector("[data-carousel-content]");
          if (content instanceof HTMLElement) {
            const items = content.querySelectorAll(":scope > *");
            // we have to translate the items instead of the content because
            // Safari scrolls the viewport if the content is translated
            const theoreticalTranslate =
              state.velocityX * RUBBER_BAND_BOUNCE_COEFFICIENT;
            const clampedTranslate =
              Math.sign(theoreticalTranslate) *
              Math.min(
                Math.abs(theoreticalTranslate),
                container2.offsetWidth / 2,
              );
            container2.style.setProperty(
              CSS_VARS.overscrollTranslateX,
              `${clampedTranslate}px`,
            );
            items.forEach((item) => {
              if (item instanceof HTMLElement) {
                item.style.translate = `var(${CSS_VARS.overscrollTranslateX}) 0`;
              }
            });
            state.velocityX *= decelerationFactor;
          }
        }

        if (Math.abs(state.velocityX) > minVelocity) {
          state.animationId = requestAnimationFrame(animate);
        } else {
          clearAnimation();
          // the carousel came to a stop under our own steam: no scroll event is
          // coming to tell us about it
          settleLoopScroll();
        }
      };

      state.animationId = requestAnimationFrame(animate);
    }, [
      clearAnimation,
      computeMomentumDecelerationFactor,
      loop,
      settleLoopScroll,
      wrapLoopScroll,
    ]);

    /**
     * Set up observers and scrolling event listeners to update the scroll state.
     */
    useLayoutEffect(() => {
      const container = viewportRef.current;
      if (container) {
        // We wait for the scroll to go quiet rather than listen for scrollend:
        // browsers fire that at the end of every snap animation, which during a
        // fast gesture means between two flicks of the wheel — teleporting there
        // is exactly what we are trying to avoid.
        let idleTimeout: MaybeUndefined<ReturnType<typeof setTimeout>>;
        const handleScrollIdle = () => {
          // the loop moves first: it teleports, which the snapping animation
          // would otherwise have to be restarted for
          settleLoopScroll();
          settleWheelSnap();
        };
        const handleScroll = () => {
          wrapLoopScroll();
          updateScrollState();
          clearTimeout(idleTimeout);
          idleTimeout = setTimeout(handleScrollIdle, SCROLL_IDLE_DELAY);
        };
        const handleContentChange = () => {
          // the loop period is only valid for the geometry it was measured on
          loopMetricsRef.current = null;
          handleScroll();
        };
        const resizeObserver = new ResizeObserver(handleContentChange);
        const mutationObserver = new MutationObserver(handleContentChange);
        resizeObserver.observe(container);
        mutationObserver.observe(container, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        container.addEventListener("scroll", handleScroll);
        handleContentChange();
        return () => {
          resizeObserver.disconnect();
          mutationObserver.disconnect();
          clearTimeout(idleTimeout);
          container.removeEventListener("scroll", handleScroll);
        };
      }
      return;
    }, [settleLoopScroll, settleWheelSnap, updateScrollState, wrapLoopScroll]);

    /**
     * Trigger momentum animation when dragging stops, dispatch click if needed.
     */
    const handlePointerUp = useCallback(
      (event: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
        scrollStateRef.current.isPointerDown = false;
        if (event.pointerType !== "mouse") {
          return;
        }
        const container = viewportRef.current;
        if ("pointerId" in event) {
          container?.releasePointerCapture?.(event.pointerId);
        }
        const state = scrollStateRef.current;
        if (!state.isDragging || !container) {
          return;
        }
        container.removeEventListener("wheel", preventWheelScroll);
        container.style.overflowX = "scroll";
        // dispatch click if needed (we prevent it on pointer down and on click)
        if (
          state.totalTraveledX <= MAX_DISTANCE_FOR_CLICK &&
          event.button === 0
        ) {
          state.isDispatchingClick = true;
          state.initialTarget?.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true }),
          );
          state.isDispatchingClick = false;
        }
        state.initialTarget = null;
        state.initialPointerPosition = null;
        state.isDragging = false;
        startMomentumAnimation();
        if (event instanceof PointerEvent) {
          return;
        }
        onPointerUp?.(event);
      },
      [onPointerUp, preventWheelScroll, startMomentumAnimation],
    );

    useEffect(() => {
      const handlePointerCancel = () => {
        scrollStateRef.current.isPointerDown = false;
      };
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
      return () => {
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerCancel);
      };
    }, [handlePointerUp]);

    // we need to keep the pre-tabbing scrollLeft, so we can restore it,
    // some browsers (safari) modify it no matter what we do to prevent it
    const lastTabScrollLeft = useRef<MaybeNull<number>>(null);

    /**
     * Scroll to the focused element into view if it's not already visible
     */
    const handleFocus = useCallback(
      (event: FocusEvent) => {
        const container = viewportRef.current;
        const { target } = event;
        if (
          container &&
          target instanceof HTMLElement &&
          target !== event.currentTarget
        ) {
          if (lastTabScrollLeft.current !== null) {
            container.scrollLeft = lastTabScrollLeft.current;
          }
          scrollIntoView(target, container, "nearest");
          lastTabScrollLeft.current = null;
        }
      },
      [scrollIntoView],
    );

    /**
     * Handle tabbing
     */
    useEffect(() => {
      const container = viewportRef.current;
      if (!container) {
        return;
      }
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          if (
            event.target instanceof HTMLElement &&
            container.contains(event.target)
          ) {
            lastTabScrollLeft.current = container.scrollLeft;
          }
        }
      };

      container.addEventListener("focus", handleFocus, { capture: true });
      document.addEventListener("keydown", handleKeyDown);
      return () => {
        container.removeEventListener("focus", handleFocus, { capture: true });
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, [handleFocus]);

    /**
     * Measure element padding, used for scrollMargin
     */
    useEffect(() => {
      const handleSetPaddingVariables = () => {
        const container = viewportRef.current;
        if (container) {
          measurePadding(container, [
            "viewportPaddingInlineStart",
            "viewportPaddingInlineEnd",
            "viewportPaddingBlockStart",
            "viewportPaddingBlockEnd",
          ]);
        }
      };

      const container = viewportRef.current;
      if (container) {
        const observer = new ResizeObserver(handleSetPaddingVariables);
        observer.observe(container);
        return () => {
          observer.disconnect();
        };
      }
    }, []);

    return (
      <div
        {...props}
        ref={combineRefs(viewportRef, forwardedRef)}
        onPointerDownCapture={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClickCapture={(event) => {
          // detail === 0 means the click was synthesized by the keyboard (Enter/Space),
          // not by a pointer device — let it through unconditionally
          if (
            scrollStateRef.current.lastPointerType === "mouse" &&
            !scrollStateRef.current.isDispatchingClick &&
            event.detail !== 0
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
          onClickCapture?.(event);
        }}
        onWheel={(event) => {
          clearAnimation();
          const state = scrollStateRef.current;
          if (state.scrollSnapType && getIsChromium()) {
            // Chromium spends a wheel scroll steering towards the snap point it
            // picked when the gesture began, and will not be talked out of it —
            // not by the carousel wrapping, not by anything. It is easier to
            // take snapping off for the duration and apply it ourselves once the
            // momentum has run out (see settleWheelSnap).
            state.isWheelSnapSuspended = true;
            event.currentTarget.style.scrollSnapType = "none";
          } else {
            event.currentTarget.style.scrollSnapType = state.scrollSnapType;
          }
          onWheel?.(event);
        }}
        data-carousel-viewport=""
        data-can-scroll={
          scrollsForwards && scrollsBackwards
            ? "both"
            : scrollsForwards
              ? "forwards"
              : scrollsBackwards
                ? "backwards"
                : "none"
        }
        className={className}
        style={
          {
            ...(contentFade
              ? {
                  [CSS_VARS.fadeSize]:
                    typeof contentFadeSize === "number"
                      ? `${contentFadeSize}px`
                      : contentFadeSize,
                  [CSS_VARS.fadeOffsetBackwards]: `min(var(${CSS_VARS.remainingBackwards}, 0px), 0px)`,
                  [CSS_VARS.fadeOffsetForwards]: `min(var(${CSS_VARS.remainingForwards}, 0px), 0px)`,
                  maskImage: `linear-gradient(
              to right,
              transparent var(${CSS_VARS.fadeOffsetBackwards}),
              #000 calc(min(var(${CSS_VARS.remainingBackwards}, 0px), var(${CSS_VARS.fadeSize})) + var(${CSS_VARS.fadeOffsetBackwards})),
              #000 calc(100% - min(var(${CSS_VARS.remainingForwards}, 0px), var(${CSS_VARS.fadeSize})) - var(${CSS_VARS.fadeOffsetForwards})),
              transparent calc(100% - var(${CSS_VARS.fadeOffsetForwards}))
            )`,
                  maskSize: "100% 100%",
                }
              : {}),
            position: "relative",
            overflowX: "scroll",
            contain: "layout style",
            msOverflowStyle: "none",
            overscrollBehaviorX: "contain",
            scrollbarColor: "transparent transparent",
            scrollbarWidth: "none",
            scrollSnapType,
            ...style,
          } as CSSProperties
        }
      >
        {children}
      </div>
    );
  },
);

CarouselViewport.displayName = "Carousel.Viewport";

type CarouselContentProps = ComponentPropsWithoutRef<"div">;

const CarouselContent = forwardRef<HTMLDivElement, CarouselContentProps>(
  ({ children, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const { loop } = useCarouselContext();
    const [duplicates, setDuplicates] = useState(0);
    const hasPositionedRef = useRef(false);
    const loopMetricsRef = useRef<MaybeNull<LoopMetrics>>(null);
    const childrenArray = useMemo(() => Children.toArray(children), [children]);
    // text nodes are not part of `content.children`: only count elements, so
    // that the indexes we measure the loop period from match the rendered DOM
    const childrenCount = useMemo(
      () => childrenArray.filter(isValidElement).length,
      [childrenArray],
    );

    /**
     * Measure element padding, used for scrollMargin
     */
    useEffect(() => {
      const handleSetPaddingVariables = () => {
        const container = containerRef.current;
        if (container) {
          measurePadding(container, [
            "contentPaddingInlineStart",
            "contentPaddingInlineEnd",
            "contentPaddingBlockStart",
            "contentPaddingBlockEnd",
          ]);
        }
      };

      const container = containerRef.current;
      if (container) {
        const observer = new ResizeObserver(handleSetPaddingVariables);
        observer.observe(container);
        return () => {
          observer.disconnect();
        };
      }
    }, []);

    /**
     * Duplicate the children until a single set covers LOOP_RUNWAY viewports,
     * then park the scroll position on the first original child. Both steps live
     * in the same effect: the duplicates land in the DOM through a re-render, so
     * the scroll position can only be trusted once the state and the DOM agree.
     */
    useLayoutEffect(() => {
      const content = containerRef.current;
      // the viewport ref is not yet initialized when the effect first runs
      const viewport = content?.closest<HTMLElement>(
        "[data-carousel-viewport]",
      );
      if (!viewport || !content) {
        return;
      }

      if (!loop) {
        hasPositionedRef.current = false;
        loopMetricsRef.current = null;
        if (duplicates !== 0) {
          // cleanup previous duplicates if needed
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setDuplicates(0);
        }
        return;
      }

      const settle = () => {
        const metrics = measureLoopMetrics(viewport);
        const viewportWidth = viewport.clientWidth;
        if (!metrics || !viewportWidth) {
          return;
        }
        const required = Math.floor(
          (LOOP_RUNWAY * viewportWidth) / metrics.naturalWidth,
        );
        if (required !== duplicates) {
          // the DOM still holds the previous copies, wait for the re-render
          // this triggers before touching the scroll position
          setDuplicates(required);
          return;
        }
        const previousMetrics = loopMetricsRef.current;
        loopMetricsRef.current = metrics;
        if (!hasPositionedRef.current) {
          // The first original child opens the middle set, which starts exactly
          // one set away from the beginning of the content. Doing this in a
          // layout effect means the browser paints the carousel there, no
          // scrolling is ever shown.
          setLoopScrollLeft(viewport, metrics.setWidth, {
            reselectSnapTarget: true,
          });
          hasPositionedRef.current = true;
        } else if (
          previousMetrics &&
          (previousMetrics.naturalWidth !== metrics.naturalWidth ||
            previousMetrics.setWidth !== metrics.setWidth)
        ) {
          // The content changed shape under us: the position we were on may no
          // longer have content on both sides of it, so take it back home.
          setLoopScrollLeft(
            viewport,
            viewport.scrollLeft - getLoopShift(viewport.scrollLeft, metrics),
            { reselectSnapTarget: true },
          );
        }
      };

      settle();

      const observer = new ResizeObserver(settle);
      observer.observe(viewport);
      observer.observe(content);

      return () => {
        observer.disconnect();
      };
    }, [childrenCount, duplicates, loop]);

    const renderedChildren = useMemo(() => {
      if (!loop) {
        return children;
      }
      const copies = duplicates + 1;
      return Array.from({ length: LOOP_SETS * copies }, (_, copyIndex) =>
        childrenArray.map((child, index) =>
          // the middle set opens on the original children, everything else is a
          // clone: hidden from assistive tech and skipped when tabbing, but
          // still visible and interactive with a pointer
          copyIndex === copies || !isValidElement(child)
            ? child
            : cloneElement(child as ReactElement<Record<string, unknown>>, {
                key: `carousel-loop-${copyIndex}-${child.key ?? index}`,
                "aria-hidden": true,
                tabIndex: -1,
                "data-loop-clone": true,
              }),
        ),
      ).flat();
    }, [children, childrenArray, duplicates, loop]);

    return (
      <div
        {...props}
        ref={combineRefs(containerRef, ref)}
        style={{ width: "fit-content", ...props.style }}
        data-carousel-content=""
        data-carousel-loop-size={loop ? childrenCount : undefined}
      >
        {renderedChildren}
      </div>
    );
  },
);

CarouselContent.displayName = "Carousel.Content";

type CarouselItemProps = ComponentPropsWithoutRef<"div"> & {
  asChild?: boolean;
};

const CarouselItem = forwardRef<HTMLElement, CarouselItemProps>(
  ({ children, asChild, ...props }, ref) => {
    const elementRef = useRef<HTMLElement>(null);
    const { loop } = useCarouselContext();
    const baseMarginInline = `var(${CSS_VARS.scrollMarginInline}, var(${CSS_VARS.fadeSize}, 0))`;

    useLayoutEffect(() => {
      const element = elementRef.current;
      if (element) {
        const paddingMargin = `calc(var(${CSS_VARS.viewportPaddingInlineStart}, 0px) + var(${CSS_VARS.contentPaddingInlineStart}, 0px))`;
        const isEdgeItem =
          element === element.parentElement?.firstElementChild ||
          element === element.parentElement?.lastElementChild;
        // When looping, every copy has to snap identically: giving the two items
        // sitting at the edges of the content their own scroll margin would
        // break the repetition the wrapping relies on — and there is no visible
        // first or last item to keep clear of the padding anyway.
        element.style.scrollMarginInline =
          isEdgeItem && !loop
            ? `max(${baseMarginInline}, ${paddingMargin})`
            : baseMarginInline;
      }
    }, [baseMarginInline, loop]);

    const baseStyle: CSSProperties = {
      // Only worth hinting when there is a translate coming: a looping carousel
      // never rubber-bands, and promoting every copy of every child would just
      // give the browser more layers to repaint when the scroll wraps.
      willChange: loop ? undefined : "transform",
      scrollMarginInline: baseMarginInline,
      ...props.style,
    };
    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<Record<string, unknown>>;
      const childRef = (children as { ref?: RefObject<unknown> }).ref;
      const { style } = child.props as { style?: CSSProperties };
      // we need to combine the refs here
      // eslint-disable-next-line react-hooks/refs
      return cloneElement(child, {
        ...props,
        ref: childRef
          ? // eslint-disable-next-line react-hooks/refs
            combineRefs(childRef, ref as RefObject<HTMLElement>, elementRef)
          : ref,
        style: { ...baseStyle, ...style },
        "data-carousel-item": "",
      });
    }
    return (
      <div
        ref={combineRefs(ref, elementRef)}
        {...props}
        style={baseStyle}
        data-carousel-item=""
      >
        {children}
      </div>
    );
  },
);

CarouselItem.displayName = "Carousel.Item";

type CarouselNextPageProps = ComponentPropsWithoutRef<"button">;

const CarouselNextPage = forwardRef<HTMLButtonElement, CarouselNextPageProps>(
  ({ children, onClick, disabled, ...props }, ref) => {
    const { scrollsForwards, handleScrollToNext } = useContext(CarouselContext);

    return (
      <button
        ref={ref}
        {...props}
        onClick={(event) => {
          handleScrollToNext();
          onClick?.(event);
        }}
        disabled={disabled ?? !scrollsForwards}
      >
        {children}
      </button>
    );
  },
);

CarouselNextPage.displayName = "Carousel.NextPage";

type CarouselPrevPageProps = ComponentPropsWithoutRef<"button">;

const CarouselPrevPage = forwardRef<HTMLButtonElement, CarouselPrevPageProps>(
  ({ children, onClick, disabled, ...props }, ref) => {
    const { scrollsBackwards, handleScrollToPrev } =
      useContext(CarouselContext);

    return (
      <button
        ref={ref}
        {...props}
        onClick={(event) => {
          handleScrollToPrev();
          onClick?.(event);
        }}
        disabled={disabled ?? !scrollsBackwards}
      >
        {children}
      </button>
    );
  },
);

CarouselPrevPage.displayName = "Carousel.PrevPage";

/**
 * Returns the computed boundary offset (used for adjusting prev / next scroll)
 */
const getBoundaryOffset = (
  boundaryOffset: CarouselContext["boundaryOffset"],
  root: HTMLElement,
) => {
  return typeof boundaryOffset === "function"
    ? boundaryOffset(root)
    : (boundaryOffset ?? { x: 0, y: 0 });
};

/**
 * Returns the normalized scroll-snap-align given a computed style.
 */
const getScrollSnapAlign = (computedStyle: MaybeNull<CSSStyleDeclaration>) => {
  if (computedStyle) {
    const scrollSnapAlign = computedStyle
      .getPropertyValue("scroll-snap-align")
      .split(" ");
    const [block, inline] = scrollSnapAlign;
    if (block && inline) {
      return [block, inline] as CSSProperties["scrollSnapAlign"][];
    } else if (block) {
      return [block, block] as CSSProperties["scrollSnapAlign"][];
    }
  }
  return [] as CSSProperties["scrollSnapAlign"][];
};

/**
 * Returns the deceleration factor needed to travel from initialScroll to
 * targetScroll given an initial velocity.
 */
const findDecelerationFactor = (
  initialScroll: number,
  targetScroll: number,
  velocity: number,
) => {
  const totalDisplacement = targetScroll - initialScroll;
  const factor = 1 + (velocity * FRAME_DURATION) / totalDisplacement;

  if (!isFinite(factor) || factor <= 0 || factor >= 1) {
    return 0.95;
  }

  return factor;
};

/**
 * Returns the final scroll position and the number of iterations required to
 * reach it, based on the given parameters.
 */
const getFinalScroll = (
  initialScroll: number,
  velocity: number,
  decelerationFactor: number,
  minVelocity = 0.05,
) => {
  if (decelerationFactor >= 1) {
    return { finalScroll: initialScroll, iterations: 0 };
  }
  // Number of frames until velocity drops below minVelocity
  const iterations = Math.ceil(
    Math.log(minVelocity / Math.abs(velocity)) / Math.log(decelerationFactor),
  );

  const finalScroll =
    initialScroll -
    (velocity *
      FRAME_DURATION *
      (1 - Math.pow(decelerationFactor, iterations))) /
      (1 - decelerationFactor);

  return { finalScroll, iterations };
};

/**
 * Combines the given refs into a single ref
 */
const combineRefs = <T,>(
  ...refs: (ForwardedRef<T> | RefObject<T> | undefined)[]
): ((node: T | null) => void) => {
  return (node) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(node);
      } else if (ref != null) {
        (ref as { current: T | null }).current = node;
      }
    });
  };
};

const iOSRubberBand = (translation: number, ratio: number, dimension = 1) => {
  const constant = 0.55;
  const easedValue =
    (1 - 1 / ((translation * constant) / dimension + 1)) * dimension;
  return easedValue * (1 - ratio);
};

const measurePadding = (
  element: HTMLElement,
  cssVars: [
    // inline start
    keyof typeof CSS_VARS,
    // inline end
    keyof typeof CSS_VARS,
    // block start
    keyof typeof CSS_VARS,
    // block end
    keyof typeof CSS_VARS,
  ],
) => {
  const [inlineStart, inlineEnd, blockStart, blockEnd] = cssVars;
  const styles = getComputedStyle(element);
  const {
    paddingInlineStart,
    paddingInlineEnd,
    paddingBlockStart,
    paddingBlockEnd,
  } = styles;
  element.style.setProperty(CSS_VARS[inlineStart], paddingInlineStart);
  element.style.setProperty(CSS_VARS[inlineEnd], paddingInlineEnd);
  element.style.setProperty(CSS_VARS[blockStart], paddingBlockStart);
  element.style.setProperty(CSS_VARS[blockEnd], paddingBlockEnd);
};

export const Carousel = {
  Root: CarouselRoot,
  Viewport: CarouselViewport,
  Content: CarouselContent,
  Item: CarouselItem,
  PrevPage: CarouselPrevPage,
  NextPage: CarouselNextPage,
  useCarouselContext,
  defaultBoundaryOffset,
  CSS_VARS,
};
