import {
  cloneElement,
  type ComponentPropsWithoutRef,
  createContext,
  type CSSProperties,
  type ForwardedRef,
  forwardRef,
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
const CSS_VARS = Object.freeze({
  fadeSize: "--carousel-fade-size",
  fadeOffsetBackwards: "--carousel-fade-offset-backwards",
  fadeOffsetForwards: "--carousel-fade-offset-forwards",
  overscrollTranslateX: "--carousel-overscroll-translate-x",
  remainingBackwards: "--carousel-remaining-backwards",
  remainingForwards: "--carousel-remaining-forwards",
});

type ScrollState = {
  isDragging: boolean;
  isDispatchingClick: boolean;
  startX: number;
  scrollLeft: number;
  lastX: number;
  lastTime: number;
  velocityX: number;
  animationId: number | null;
  initialTarget: MaybeNull<EventTarget>;
  initialPointerPosition: MaybeNull<{
    x: number;
    y: number;
  }>;
  mouseDirection: number;
  scrollSnapType: string;
  cachedScrollWidth: number;
  cachedOffsetWidth: number;
};

type ScrollIntoView = (
  target: HTMLElement,
  container: HTMLElement,
  direction: "forwards" | "backwards" | "nearest",
) => void;

type CarouselContext = {
  ref?: RefObject<MaybeNull<HTMLElement>>;
  setRef: (ref: RefObject<MaybeNull<HTMLElement>>) => void;
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
  setRef: () => {},
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

type CarouselRootProps = {
  boundaryOffset?:
    | { x: number; y: number }
    | ((root: HTMLElement) => { x: number; y: number });
} & ComponentPropsWithoutRef<"div">;

const CarouselRoot = forwardRef<HTMLDivElement, CarouselRootProps>(
  (
    { boundaryOffset = defaultBoundaryOffset, children, ...props },
    forwardedRef,
  ) => {
    const [ref, setRef] = useState<RefObject<MaybeNull<HTMLElement>>>({
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
      const container = ref.current;
      if (!container) {
        return;
      }
      container.style.removeProperty(CSS_VARS.overscrollTranslateX);
      const allItems = container.querySelectorAll(
        ":scope [data-carousel-content] > *",
      );
      allItems.forEach((item) => {
        if (item instanceof HTMLElement) {
          item.style.translate = "";
        }
      });
    }, [ref, scrollStateRef]);

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
                item.offsetLeft + item.offsetWidth >
                currentScroll + container.offsetWidth - offset,
            );
            if (
              nextItem &&
              nextItem.offsetWidth < container.offsetWidth - offset * 2
            ) {
              delta = nextItem.offsetLeft - container.scrollLeft - offset;
            }
          } else {
            const prevItem = items
              .filter((item) => item.offsetLeft < currentScroll + offset)
              .reverse()[0];
            if (
              prevItem &&
              prevItem.offsetWidth < container.offsetWidth - offset * 2
            ) {
              delta =
                container.scrollLeft -
                prevItem.offsetLeft -
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
        const currentScroll = container.scrollLeft;
        container.style.scrollSnapType =
          scrollStateRef?.current?.scrollSnapType ?? "";
        container.scrollTo({ left: targetScroll, behavior: "instant" });
        const snappedScrollPosition = container.scrollLeft;
        container.scrollTo({ left: currentScroll, behavior: "instant" });
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
          const isBefore = target.offsetLeft < container.scrollLeft + offset;
          const isAfter =
            target.offsetLeft + target.offsetWidth >
            container.scrollLeft + container.offsetWidth - offset;
          return { isBefore, isAfter };
        };
        let { isBefore, isAfter } = getIsBeforeAfter();
        // Default when the target is larger than the container
        if (isBefore && isAfter) {
          const scrollPosition = target.offsetLeft - offset;
          container.scrollTo({
            left: scrollPosition <= offset ? 0 : scrollPosition,
            behavior: "smooth",
          });
        } else if (isBefore || isAfter) {
          const currentScroll = container.scrollLeft;
          let scrollPosition = isBefore
            ? target.offsetLeft - offset
            : target.offsetLeft -
              container.offsetWidth +
              target.offsetWidth +
              offset;
          let iterations = 0;
          const maxIterations = 20;
          // Adjust scroll position to account for snapping, if the target is
          // still before or after, we increment / decrement the scroll position
          container.style.scrollSnapType =
            scrollStateRef?.current?.scrollSnapType ?? "";
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
        let scrollPosition =
          direction === "forwards"
            ? target.offsetLeft - offset
            : target.offsetLeft -
              container.offsetWidth +
              target.offsetWidth +
              offset;
        if (inline === "center") {
          scrollPosition =
            target.offsetLeft -
            (container.offsetWidth - target.offsetWidth) / 2;
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
      const container = ref?.current;
      const root = rootRef?.current;
      if (root && container && container.scrollLeft < container.scrollWidth) {
        // this is a ref, although it's in a state to be able to pass it around,
        // it is safe to mutate it, using the setter would cause unwanted re-renders
        // eslint-disable-next-line react-hooks/immutability
        container.style.scrollSnapType =
          scrollStateRef?.current?.scrollSnapType ?? "";
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
            item.offsetLeft + item.offsetWidth >
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
      ref,
      scrollIntoView,
      scrollStateRef,
    ]);

    /**
     * Scrolls the container to the previous slide until hitting the start of the container
     */
    const handleScrollToPrev = useCallback(() => {
      clearAnimation();
      const container = ref?.current;
      const root = rootRef?.current;
      if (root && container && container.scrollLeft > 0) {
        // this is a ref, although it's in a state to be able to pass it around,
        // it is safe to mutate it, using the setter would cause unwanted re-renders
        // eslint-disable-next-line react-hooks/immutability
        container.style.scrollSnapType =
          scrollStateRef?.current?.scrollSnapType ?? "";
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
          return currentScroll > item.offsetLeft - boundaryOffsetX;
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
      ref,
      scrollIntoView,
      scrollStateRef,
    ]);

    const carouselContext = useMemo<CarouselContext>(() => {
      return {
        ref,
        setRef,
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
      ref,
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
      setRef,
      setScrollsBackwards,
      setScrollsForwards,
      scrollsForwards,
      scrollsBackwards,
      scrollIntoView,
      setRemainingForwards,
      setRemainingBackwards,
      setScrollStateRef,
      clearAnimation,
      rootRef,
    } = useContext(CarouselContext);
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollStateRef = useRef<ScrollState>({
      isDragging: false,
      isDispatchingClick: false,
      startX: 0,
      scrollLeft: 0,
      lastX: 0,
      lastTime: 0,
      velocityX: 0,
      animationId: null as number | null,
      initialTarget: null as MaybeNull<EventTarget>,
      initialPointerPosition: null as MaybeNull<{ x: number; y: number }>,
      mouseDirection: 0,
      scrollSnapType: scrollSnapType ?? "",
      cachedScrollWidth: 0,
      cachedOffsetWidth: 0,
    });

    // Keep the ref in sync with the prop on every render so event handlers
    // always see the current value without needing a layout effect.
    // eslint-disable-next-line react-hooks/refs
    scrollStateRef.current.scrollSnapType = scrollSnapType ?? "";

    /**
     * Register our refs; Layout effect to make sure we render the arrows
     * or the content-fade in the initial frame
     */
    useLayoutEffect(() => {
      setRef(containerRef);
      setScrollStateRef(scrollStateRef);
    }, [setRef, setScrollStateRef]);

    /**
     * Determine whether the container can scroll forwards or backwards based on
     * its current scroll position, offset width, and scroll width. Updates
     * relevant state and CSS variables.
     */
    const updateScrollState = useCallback(() => {
      const container = containerRef.current;
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
      setRemainingBackwards,
      setRemainingForwards,
      setScrollsBackwards,
      setScrollsForwards,
    ]);

    /**
     * Prevent native scroll when dragging
     */
    const preventWheelScroll = useCallback((event: WheelEvent) => {
      event.preventDefault();
    }, []);

    /**
     * Set up observers and scrolling event listeners to update the scroll state.
     */
    useLayoutEffect(() => {
      const container = containerRef.current;
      if (container) {
        const resizeObserver = new ResizeObserver(updateScrollState);
        const mutationObserver = new MutationObserver(updateScrollState);
        resizeObserver.observe(container);
        mutationObserver.observe(container, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        container.addEventListener("scroll", updateScrollState);
        updateScrollState();
        return () => {
          resizeObserver.disconnect();
          mutationObserver.disconnect();
          container.removeEventListener("scroll", updateScrollState);
        };
      }
      return;
    }, [updateScrollState]);

    /**
     * Initialize dragging.
     */
    const handlePointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.pointerType !== "mouse" || event.button !== 0) {
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);

        const state = scrollStateRef.current;
        if (state.animationId !== null) {
          cancelAnimationFrame(state.animationId);
          state.animationId = null;
        }

        const container = containerRef.current;
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
        const container = containerRef.current;
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
        state.lastX = event.clientX;
        state.lastTime = currentTime;

        if (
          container.scrollLeft <= 1 ||
          container.scrollLeft >=
            container.scrollWidth - container.offsetWidth - 1
        ) {
          applyRubberBanding(container, scrollDelta);
          clampVelocity(maxAbsoluteVelocity);
        }
        onPointerMove?.(event);
      },
      [applyRubberBanding, clampVelocity, onPointerMove],
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

        // Find where the browser would snap to at tFinalScroll
        container.style.scrollSnapType = state.scrollSnapType;
        container.scrollLeft = tFinalScroll;
        const snappedScroll = container.scrollLeft;
        container.style.scrollSnapType = "none";
        container.scrollLeft = initialScroll;

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
      [],
    );

    /**
     * Returns the deceleration factor for the momentum animation, accounting for
     * snapping if needed.
     */
    const computeMomentumDecelerationFactor = useCallback(
      (container: HTMLDivElement, minVelocity: number) => {
        const minVelocityForSnapping = 0;
        const state = scrollStateRef.current;
        const isRubberBanding =
          container.scrollLeft <= 1 ||
          container.scrollLeft >=
            state.cachedScrollWidth - state.cachedOffsetWidth - 1;
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
          !isRubberBanding &&
          finalScroll < state.cachedScrollWidth - state.cachedOffsetWidth &&
          finalScroll > 0 &&
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
      [applyMomentumSnapping],
    );

    /**
     * Start the momentum animation if needed.
     */
    const startMomentumAnimation = useCallback(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const state = scrollStateRef.current;
      state.cachedScrollWidth = container.scrollWidth;
      state.cachedOffsetWidth = container.offsetWidth;
      const minVelocity = 0.00001;
      const decelerationFactor = computeMomentumDecelerationFactor(
        container,
        minVelocity,
      );

      const animate = () => {
        const container2 = containerRef.current;
        if (!container2) {
          return;
        }

        container2.style.scrollSnapType = "none";
        container2.scrollLeft -= state.velocityX * FRAME_DURATION;
        state.scrollLeft = container2.scrollLeft;
        state.velocityX *= decelerationFactor;

        const newScrollLeft = container2.scrollLeft;
        const scrollWidth = state.cachedScrollWidth;
        const offsetWidth = state.cachedOffsetWidth;
        const remainingForwards = scrollWidth - offsetWidth - newScrollLeft;
        const remainingBackwards = newScrollLeft;

        // Overscroll rubber band bounce-back
        if (
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
        }
      };

      state.animationId = requestAnimationFrame(animate);
    }, [clearAnimation, computeMomentumDecelerationFactor]);

    /**
     * Trigger momentum animation when dragging stops, dispatch click if needed.
     */
    const handlePointerUp = useCallback(
      (event: React.PointerEvent<HTMLDivElement> | PointerEvent) => {
        if (event.pointerType !== "mouse") {
          return;
        }
        const container = containerRef.current;
        if ("pointerId" in event) {
          container?.releasePointerCapture(event.pointerId);
        }
        const state = scrollStateRef.current;
        if (!state.isDragging || !container) {
          return;
        }
        container.removeEventListener("wheel", preventWheelScroll);
        container.style.overflowX = "";
        // dispatch click if needed (we prevented it on pointer down)
        if (
          state.initialPointerPosition &&
          Math.hypot(
            state.initialPointerPosition.x - event.clientX,
            state.initialPointerPosition.y - event.clientY,
          ) < 3
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
      document.addEventListener("pointerup", handlePointerUp);
      return () => {
        document.removeEventListener("pointerup", handlePointerUp);
      };
    }, [handlePointerUp]);

    const lastTabScrollLeft = useRef<MaybeNull<number>>(null);

    /**
     * Scroll to the focused element into view if it's not already visible
     */
    const handleFocus = useCallback(
      (event: FocusEvent) => {
        const container = containerRef.current;
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

    useEffect(() => {
      const container = containerRef.current;
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

    return (
      <div
        ref={combineRefs(containerRef, forwardedRef)}
        {...props}
        onPointerDownCapture={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onClickCapture={(event) => {
          // detail === 0 means the click was synthesized by the keyboard (Enter/Space),
          // not by a pointer device — let it through unconditionally
          if (
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
          event.currentTarget.style.scrollSnapType =
            scrollStateRef.current.scrollSnapType;
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
            overflow: "scroll",
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
    return (
      <div
        ref={ref}
        {...props}
        style={{ width: "fit-content", ...props.style }}
        data-carousel-content=""
      >
        {children}
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
    if (asChild && isValidElement(children)) {
      const child = children as ReactElement<Record<string, unknown>>;
      const childRef = (children as { ref?: RefObject<unknown> }).ref;
      // we need to combine the refs here
      // eslint-disable-next-line react-hooks/refs
      return cloneElement(child, {
        ...props,
        // eslint-disable-next-line react-hooks/refs
        ref: childRef ? combineRefs(childRef, ref as RefObject<unknown>) : ref,
        "data-carousel-item": "",
      });
    }
    return (
      <div
        ref={ref as RefObject<HTMLDivElement>}
        {...props}
        style={{ willChange: "transform", ...props.style }}
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
