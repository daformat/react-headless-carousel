import {
  Children,
  cloneElement,
  type ComponentPropsWithoutRef,
  createContext,
  type CSSProperties,
  type ForwardedRef,
  forwardRef,
  isValidElement,
  type ReactElement,
  type RefAttributes,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Maybe, MaybeNull, MaybeUndefined } from "./utils/maybe.js";

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
/**
 * How much of an item an autoplay step has to cover to be worth making, as a
 * fraction of that item's width.
 */
const MIN_AUTOPLAY_STEP = 0.5;
/**
 * How long the autoplay waits after the user has scrolled or dragged before
 * picking up again.
 */
const AUTOPLAY_RESUME_DELAY = 1500;
/**
 * How long after a wheel event the browser still counts as running a scroll of
 * its own. Momentum keeps the events coming, so this only has to cover the gap
 * between two of them.
 */
const WHEEL_GESTURE_TIMEOUT = 250;

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
   * Where a scroll started for the focus is heading, and whether one is being
   * started right now. A wrap can happen while such a scroll is still running:
   * it moves every copy along by a whole period, and the destination has to go
   * with them. Kept for tabbing alone — a wheel or a drag has its own machinery
   * for surviving a wrap, and is left well out of this.
   */
  focusScrollDestination: MaybeNull<number>;
  isFocusScrolling: boolean;
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
  /**
   * Whether the carousel has been told to animate its scrolls regardless of
   * `prefers-reduced-motion`. Kept here so the scrolling has it to hand: it is
   * `Carousel.Root` that takes the prop, and the scrolls are made from all over.
   */
  ignoresReducedMotion: boolean;
  /**
   * Where the scroll was as of the last scroll event. Adding or removing the
   * looping copies changes how much content sits in front of the position, and
   * once they are gone the browser has already clamped `scrollLeft` — so the
   * figure has to have been kept beforehand.
   */
  lastScrollLeft: number;
  /**
   * When the last wheel event came in. A wheel scroll keeps sending them for as
   * long as its momentum runs, so this says whether the browser is currently
   * steering a scroll of its own — which is the only time the carousel has any
   * business taking snapping away from it.
   */
  lastWheelTime: number;
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
  handleScrollToNext: (mode?: CarouselScrollMode) => void;
  handleScrollToPrev: (mode?: CarouselScrollMode) => void;
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
    // A carousel without a content fade never sets the variable, so there is
    // nothing to parse and no inset to apply. Handing back the `NaN` instead
    // would quietly disable every comparison it is used in — an element is
    // never before or after a boundary that is `NaN` — and the carousel would
    // stop scrolling anything into view at all.
    return { x: Number.isFinite(fadeSize) ? fadeSize : 0, y: 0 };
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
 * The same element as the one given, `copies` copies further along the content:
 * the one that shows the same thing, somewhere else. Every copy renders the same
 * markup, so it is found by walking the same path inside the item that many
 * copies away.
 */
/**
 * Set while the loop hands the focus from one copy to another. What it lands on
 * is, by construction, the thing already under the user's eye — so the focus
 * handler must not then go scrolling it into view. Left to itself it would:
 * a copy sitting a few pixels short of the viewport edge counts as "not fully
 * visible", and mandatory snapping turns those few pixels into a jump back to
 * the previous snap point.
 */
let isRelocatingLoopFocus = false;

const focusWithoutScrolling = (element: HTMLElement) => {
  isRelocatingLoopFocus = true;
  element.focus({ preventScroll: true });
  isRelocatingLoopFocus = false;
};

/**
 * Everything the browser will stop at when tabbing, near enough: what it leaves
 * out (`display: none`, a closed `<details>`) is filtered out below anyway by
 * having to be on screen.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "details",
  "summary",
  "iframe",
  "object",
  "embed",
  "audio[controls]",
  "video[controls]",
  "[contenteditable]",
  "[tabindex]",
].join(",");

/**
 * What tabbing can land on inside the carousel, in document order. The loop's
 * copies count: a copy on screen is a real part of the carousel to whoever is
 * looking at it.
 */
const getTabbableElements = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.hasAttribute("disabled") &&
      !element.closest("[inert]"),
  );

/**
 * Whether an element is on screen, judged by the carousel item holding it
 * rather than by the element itself: items are what the carousel scrolls by, so
 * a button at the far edge of one counts as visible exactly when its item does.
 */
const isWithinScrollport = (element: HTMLElement, container: HTMLElement) => {
  const measured =
    element.closest<HTMLElement>("[data-carousel-item]") ?? element;
  const left = getOffsetLeft(measured, container);
  const { scrollLeft } = container;
  return (
    left >= scrollLeft - 1 &&
    left + measured.offsetWidth <= scrollLeft + container.offsetWidth + 1
  );
};

const getLoopTwin = (
  element: HTMLElement,
  copies: number,
): MaybeNull<HTMLElement> => {
  const item = element.closest<HTMLElement>("[data-carousel-item]");
  const content = item?.parentElement;
  const childrenCount = Number(
    content?.getAttribute("data-carousel-loop-size") ?? 0,
  );
  if (!item || !content || !childrenCount || !copies) {
    return null;
  }
  const items = Array.from(content.children);
  let index = items.indexOf(item) + copies * childrenCount;
  // near either end the twin can fall off the array; the copy one period along
  // shows the same child, so walk back into range rather than giving up
  while (index < 0) {
    index += childrenCount;
  }
  while (index >= items.length) {
    index -= childrenCount;
  }
  const twin = items[index];
  if (!(twin instanceof HTMLElement) || twin === item) {
    return null;
  }
  const path: number[] = [];
  for (
    let node: HTMLElement = element;
    node !== item && node.parentElement;
    node = node.parentElement
  ) {
    path.unshift(
      Array.prototype.indexOf.call(node.parentElement.children, node),
    );
  }
  let target: Element = twin;
  for (const step of path) {
    const next = target.children[step];
    if (!next) {
      return null;
    }
    target = next;
  }
  return target instanceof HTMLElement ? target : null;
};

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
 * Whether the user has asked for less movement. Asked afresh every time rather
 * than remembered, so a preference changed mid-session applies to the very next
 * scroll without anything having to be listening for it.
 */
const prefersReducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * What to ask the browser for, once the user's motion preference has had its
 * say. Someone who has asked for less of it is not asking to be taken somewhere
 * else: the destination is theirs either way, it is the journey they do
 * without. A carousel sweeps a good part of the screen sideways to get there,
 * which is exactly the kind of movement the preference is about.
 *
 * Only what the carousel animates itself goes through here. A drag is the
 * user's own hand, and the momentum that carries on from it is the gesture they
 * made finishing: taking that away would leave the carousel stopping dead under
 * their finger, which is less control rather than less motion.
 */
const resolveScrollBehavior = (
  behavior: ScrollToOptions["behavior"],
  state: Maybe<ScrollState>,
): ScrollToOptions["behavior"] =>
  behavior !== "instant" &&
  !state?.ignoresReducedMotion &&
  prefersReducedMotion()
    ? "instant"
    : behavior;

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
 *
 * That is a Chromium habit, and the toggle is kept for Chromium only: the other
 * engines have no such attachment, and a style change on the scroller costs them
 * the snap they were about to apply.
 */
const setLoopScrollLeft = (
  container: HTMLElement,
  scrollLeft: number,
  {
    reselectSnapTarget = false,
    keepFocus = false,
  }: { reselectSnapTarget?: boolean; keepFocus?: boolean } = {},
) => {
  const reselect = reselectSnapTarget && getIsChromium();
  const scrollSnapType = container.style.scrollSnapType;
  const before = container.scrollLeft;
  if (reselect) {
    container.style.scrollSnapType = "none";
  }
  container.scrollTo({ left: scrollLeft, behavior: "instant" });
  if (reselect) {
    container.style.scrollSnapType = scrollSnapType;
  }
  // `keepFocus` is for the jumps made on the focus's behalf: those move the
  // scroll to suit the focused element, so following the focus afterwards would
  // undo the very thing the jump was for
  if (!keepFocus) {
    relocateFocusToLoopTwin(container, container.scrollLeft - before);
  }
};

/**
 * Follows the focus across a teleport.
 *
 * The jump leaves the pixels on screen exactly as they were, but the elements
 * showing them are a whole number of copies further along — so anything focused
 * inside a copy has just been carried off screen, and the focus ring with it.
 * This hands the focus to the element that took its place: the same position in
 * the copy now standing where the old one stood.
 *
 * It follows in both directions, copies included. Leaving the focus behind on a
 * child that has just been carried off screen is what makes the focus ring
 * appear to vanish a moment after tabbing — the ring is still on the element,
 * the element is simply a copy's width away from where the user is looking.
 */
const relocateFocusToLoopTwin = (container: HTMLElement, delta: number) => {
  const active = document.activeElement;
  const metrics = measureLoopMetrics(container);
  if (
    !delta ||
    !metrics ||
    !(active instanceof HTMLElement) ||
    !container.contains(active)
  ) {
    return;
  }
  // the copies repeat every period, so the number of them the scroll moved by
  // is the number the focus has to move by to stay where the user is looking
  const target = getLoopTwin(active, Math.round(delta / metrics.naturalWidth));
  if (!target) {
    return;
  }
  focusWithoutScrolling(target);
};

/**
 * Closes the distance to an element the tab order has just moved to, without
 * showing the journey.
 *
 * The copies mean the same pixels come round every `naturalWidth`, so the scroll
 * can cross whole periods of them for nothing: the position it lands on shows
 * exactly what the one it left did. What that buys is the difference between a
 * carousel that appears to scroll backwards across its whole content to reach
 * the child the DOM offers next, and one that simply carries on — the jump is
 * invisible, and only the last few pixels are left for the animation that
 * follows, going the way the user was already going.
 *
 * Returns the delta it applied, which is always a whole number of periods.
 */
const teleportTowardsFocus = (
  container: HTMLElement,
  target: HTMLElement,
  backwards: boolean,
) => {
  const metrics = measureLoopMetrics(container);
  if (!metrics) {
    return 0;
  }
  // items are what the carousel scrolls by, so a button at the far edge of one
  // counts as being wherever its item is
  const anchor = target.closest<HTMLElement>("[data-carousel-item]") ?? target;
  const left = getOffsetLeft(anchor, container);
  const start = container.scrollLeft;
  // measured from the edge of the viewport rather than from the scroll
  // position: what matters is how far outside the visible band the element is,
  // which is nothing at all when it is already on screen
  const end = start + container.offsetWidth - anchor.offsetWidth;
  const gap = left < start ? left - start : Math.max(0, left - end);
  // Rounding to the nearest copy would pick the shortest remaining distance,
  // which is sometimes backwards — and a carousel that backs up while the user
  // tabs forwards is the whole complaint. Rounding *down* instead (up, when
  // shift-tabbing) always leaves the element on the far side of the viewport,
  // so what little is left to animate goes the way the tabbing is going. It can
  // be a slightly longer trip; it is never a trip in the wrong direction.
  const periods = backwards
    ? Math.ceil(gap / metrics.naturalWidth)
    : Math.floor(gap / metrics.naturalWidth);
  if (!periods) {
    return 0;
  }
  const shifted = start + periods * metrics.naturalWidth;
  const maxScroll = container.scrollWidth - container.offsetWidth;
  if (shifted < 0 || shifted > maxScroll) {
    // The scroll cannot go that way: there is no more content on that side.
    // Tabbing into a carousel is where this shows up — the first thing in the
    // tab order is the first copy of the first child, right at the start of the
    // content, and travelling to it means sweeping backwards across everything.
    // The copies make the same child reachable the other way round, so the
    // focus goes to the one already within reach and the scroll stays put.
    //
    // Which copy is simply the nearest one: the bias that keeps the *scroll*
    // moving the way the tabbing goes has no place here, and rounding away from
    // the viewport would land a whole period past what is already on screen.
    const copies = Math.round((start - left) / metrics.naturalWidth);
    const twin = getLoopTwin(target, copies);
    if (twin) {
      focusWithoutScrolling(twin);
    }
    return 0;
  }
  setLoopScrollLeft(container, shifted, { keepFocus: true });
  return container.scrollLeft - start;
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

/** What one turn of the autoplay does */
/**
 * How far one move goes, whether a button was clicked or the autoplay ticked.
 *
 * - `page` brings the next item that is not fully in view fully into view. It
 *   is the one that keeps a partly-seen item from staying partly seen, which is
 *   why it is what the prev / next buttons do unless told otherwise.
 * - `item` steps to the next item along, whether or not the current one is
 *   fully in view. Items smaller than the viewport move one at a time.
 * - `viewport` moves by exactly what the viewport can show, ignoring where the
 *   items fall. Whatever `scroll-snap-type` asks for still applies on landing.
 */
type CarouselScrollMode = "page" | "item" | "viewport";
type CarouselAutoplayStepMode = CarouselScrollMode;
type CarouselAutoplayMode = "continuous" | CarouselAutoplayStepMode;
type CarouselAutoplayDirection = "forwards" | "backwards";
/** What to do once a carousel that does not loop runs out of content */
type CarouselAutoplayAtEnd = "rewind" | "reverse" | "stop";

type CarouselAutoplayBase = {
  direction?: CarouselAutoplayDirection;
  /** Pause while the pointer is over the carousel. On by default */
  pauseOnHover?: boolean;
  /** Pause while the focus is anywhere inside the carousel. On by default */
  pauseOnFocus?: boolean;
  /**
   * How long to wait, in milliseconds, after the user has scrolled or dragged
   * the carousel before picking up again. `false` carries on regardless.
   * Defaults to 1500.
   *
   * Hovering and focusing describe a mouse and a keyboard. A touch has neither,
   * so on a phone this is the only thing standing between someone reading an
   * item and the carousel taking it away from them.
   */
  pauseOnInteraction?: number | false;
};

/**
 * What to do when the carousel runs out of content. Only offered to a carousel
 * that can: a looping one tops itself back up long before it reaches an end, so
 * there is never an end to handle — see CarouselRootProps, which is what decides
 * whether these are on the table.
 */
type CarouselAutoplayEndOptions = {
  /**
   * `rewind` goes back to the end it started from and carries on, `reverse`
   * turns around and plays back the way it came, `stop` leaves it there.
   * Rewinds by default.
   */
  atEnd?: CarouselAutoplayAtEnd;
};

/**
 * The options that are not on offer in a given shape are typed as the reason
 * why, rather than as `never`: assigning to one then has the compiler quote the
 * reason back — "Type 'number' is not assignable to type '`speed` is for
 * mode: continuous...'" — which says considerably more than "not assignable to
 * type 'undefined'".
 */
type NoSpeed =
  "`speed` is for mode: 'continuous', stepping takes `interval` instead";
type NoInterval =
  "`interval` is for mode: 'item' and mode: 'page', a continuous scroll takes `speed` instead";
type NoPauseAtEndHere = "`pauseAtEnd` is for mode: 'continuous'";
type NoAtEnd =
  "`atEnd` does not apply with loop: a looping carousel never runs out of content";
type NoPauseAtEnd =
  "`pauseAtEnd` does not apply with loop: a looping carousel never reaches an end to wait at";

/**
 * `CanEnd` says whether the carousel is one that can run out of content, which
 * is the only time the `atEnd` options mean anything.
 */
type CarouselAutoplayOptions<CanEnd extends boolean = false> =
  | (CarouselAutoplayBase & {
      /** Scrolls the viewport at a steady speed, without stopping on items */
      mode: "continuous";
      /** How fast to scroll, in pixels per second. Defaults to 60 */
      speed?: number;
      interval?: NoInterval;
    } & (CanEnd extends true
        ? CarouselAutoplayEndOptions & {
            /**
             * How long to sit still on reaching the end — or the start, on the
             * way back — before `atEnd` turns it around or takes it home, in
             * milliseconds. Turns straight around by default.
             */
            pauseAtEnd?: number;
          }
        : { atEnd?: NoAtEnd; pauseAtEnd?: NoPauseAtEnd }))
  | (CarouselAutoplayBase & {
      /**
       * How far each step goes: to the next item, to the next viewport worth of
       * them, or by the viewport itself. The same three the prev / next buttons
       * take, see {@link CarouselScrollMode}. Items by default.
       */
      mode?: CarouselAutoplayStepMode;
      /** How long to wait between steps, in milliseconds. Defaults to 3000 */
      interval?: number;
      speed?: NoSpeed;
      pauseAtEnd?: NoPauseAtEndHere;
    } & (CanEnd extends true
        ? CarouselAutoplayEndOptions
        : { atEnd?: NoAtEnd }));

/** Every autoplay option, whichever way the props narrowed them */
type ResolvedAutoplayOptions = CarouselAutoplayBase &
  CarouselAutoplayEndOptions & {
    mode?: CarouselAutoplayMode;
    speed?: number;
    interval?: number;
    pauseAtEnd?: number;
  };

/**
 * Inset from the leading and trailing edges of the viewport, used when scrolling
 * items into view. Either a fixed pair or a function given the root element.
 */
type CarouselBoundaryOffset =
  | { x: number; y: number }
  | ((root: HTMLElement) => { x: number; y: number });

/**
 * What to do about `prefers-reduced-motion: reduce`. Respecting it is the
 * default and covers the two things the carousel does of its own accord:
 * autoplay does not run, and the scrolls it animates arrive instantly instead.
 * `"ignore"` is for an app that has already made that decision elsewhere.
 */
type CarouselReducedMotion = "respect" | "ignore";

type CarouselRootBaseProps = {
  boundaryOffset?: CarouselBoundaryOffset;
  /** Defaults to `"respect"`. See {@link CarouselReducedMotion}. */
  reducedMotion?: CarouselReducedMotion;
} & ComponentPropsWithoutRef<"div">;

/**
 * Which autoplay options are on offer depends on `loop`: a looping carousel
 * never runs out of content, so the `atEnd` options would sit there doing
 * nothing. Rather than accept them and quietly ignore them, they are only part
 * of the type when the carousel can actually reach an end.
 *
 * `Loop` follows whatever `loop` is given, so the ruling tracks how much is
 * known about it. A literal settles the question either way. A `boolean` that
 * only resolves at runtime leaves it open, and the conditional below hands back
 * both shapes: the `atEnd` options do their job on the runs that come out
 * `false` and sit inert on the runs that do not, which is a good deal better
 * than a wrapper being unable to pass its own `loop` prop straight through.
 *
 * Defaults to `boolean` when named directly — `Carousel.RootProps` on its own
 * describes a carousel that could be looping or not, the same set it always
 * described. `Carousel.Root` defaults it to `false` instead, matching the
 * carousel you get when you leave `loop` off.
 */
type CarouselRootProps<Loop extends boolean = boolean> =
  CarouselRootBaseProps & {
    /** Off by default: the carousel runs out of content at either end */
    loop?: Loop;
    /**
     * Scrolls the carousel on its own. `true` steps to the next item every
     * three seconds; pass an object to choose how and how fast, and — unless
     * `loop` is literally `true` — what to do once it runs out of content.
     */
    autoplay?:
      | boolean
      | CarouselAutoplayOptions<Loop extends true ? false : true>;
  };

const CarouselRootImpl = forwardRef<HTMLDivElement, CarouselRootProps>(
  (
    {
      boundaryOffset = defaultBoundaryOffset,
      loop = false,
      autoplay = false,
      reducedMotion = "respect",
      children,
      ...props
    },
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

    // The prop is ours, the scrolling is spread across both components, so it
    // goes where the scrolling already looks. Kept in step on every render, as
    // the viewport does with its own props.
    if (scrollStateRef?.current) {
      scrollStateRef.current.ignoresReducedMotion = reducedMotion === "ignore";
    }

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
      // Dragging and momentum turn snapping off while they run, give the user
      // back the snapping they asked for now that nothing is animating — unless
      // a wrap has taken it over for a wheel scroll that is still going, in
      // which case settleWheelSnap is the one that gives it back.
      if (!state.isWheelSnapSuspended) {
        container.style.scrollSnapType = state.scrollSnapType;
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
    }, [viewportRef, scrollStateRef]);

    /**
     * Scroll the whole page (the container client width)
     *
     * `alignToItem` is what separates a `page` from a `viewport`: both start out
     * as one viewport's worth, and a page then trims it back to the edge of the
     * item it would otherwise cut in half. Without that trim it moves by exactly
     * what the viewport can show and lets the items fall where they may.
     */
    const handleScrollPage = useCallback(
      (
        direction: "forwards" | "backwards",
        container: HTMLElement,
        items: HTMLElement[],
        { alignToItem = true }: { alignToItem?: boolean } = {},
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
        if (alignToItem && items.length > 1) {
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
        container.scrollTo({
          left: nextScrollPosition,
          behavior: resolveScrollBehavior("smooth", scrollStateRef?.current),
        });
      },
      [boundaryOffset, scrollStateRef],
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
        // only a scroll the tabbing asked for is remembered: it is the one a
        // wrap has to carry along, and the only one whose destination we own
        const state = scrollStateRef?.current;
        const isForFocus = !!state?.isFocusScrolling;
        if (isForFocus && state) {
          // eslint-disable-next-line react-hooks/immutability
          state.focusScrollDestination = snappedScroll;
        }
        // request animation frame to prevent Safari from being Safari
        requestAnimationFrame(() => {
          // A wrap can land inside the frame this waited out, moving every copy
          // along by whole periods — and the destination with them. Reading it
          // back rather than closing over it keeps this from scrolling to where
          // the content used to be, which is a journey of whole copies across
          // the whole carousel. Chromium fires this frame before the wrap gets
          // a chance; Firefox does not, which is where it shows.
          const carried = isForFocus ? state?.focusScrollDestination : null;
          const left = carried ?? snappedScroll;
          container.scrollTo({
            left,
            behavior: resolveScrollBehavior(behavior, state),
          });
        });
      },
      [scrollStateRef, snapScroll],
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
            behavior: resolveScrollBehavior("smooth", scrollStateRef?.current),
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

    const scrollToAdjacentItem = useCallback(
      (direction: "forwards" | "backwards") => {
        const container = viewportRef?.current;
        const root = rootRef.current;
        if (!container || !root) {
          return false;
        }
        if (loop) {
          // start from the middle of the repeated content, so the scroll we are
          // about to animate cannot run out of content and be cut short by a wrap
          recenterLoopScroll(container);
        }
        const items = Array.from(
          container.querySelectorAll(":scope [data-carousel-content] > *"),
        ) as HTMLElement[];
        const { x: offsetX } = getBoundaryOffset(boundaryOffset, root);
        const alignmentOf = (item: HTMLElement) =>
          getScrollSnapAlign(getComputedStyle(item))[1];
        /**
         * Which edge scrollIntoView has to line this item up against for it to
         * land where its `scroll-snap-align` says it should.
         */
        const edgeFor = (item: HTMLElement) =>
          alignmentOf(item) === "end"
            ? ("backwards" as const)
            : ("forwards" as const);
        /**
         * Where the carousel would come to rest with this item lined up — the
         * same sums scrollIntoView does. Going by where each item *sits* rather
         * than by its place in the list is what makes this work for any
         * `scroll-snap-align`: with `center` the item at the leading edge is a
         * whole item behind the one the viewer would call current, and stepping
         * from it would ask for a position the carousel is already at.
         */
        const restingPosition = (item: HTMLElement) => {
          const left = getOffsetLeft(item, container);
          const alignment = alignmentOf(item);
          if (alignment === "center") {
            return left - (container.offsetWidth - item.offsetWidth) / 2;
          }
          if (alignment === "end") {
            return left - container.offsetWidth + item.offsetWidth + offsetX;
          }
          return left - offsetX;
        };
        /**
         * Far enough to be worth going to. An item whose resting place is all
         * but where the carousel already sits would make for a step nobody can
         * see — and the tick after it would be asked to make the same one — so
         * it is passed over for the one behind it. Half an item is generous
         * enough to catch that and small enough never to skip a real step.
         */
        const scrollLeft = container.scrollLeft;
        const maxScroll = container.scrollWidth - container.clientWidth;
        const isWorthGoingTo = (item: HTMLElement) => {
          // Where it would land, not where it would like to: the last items of
          // a centred carousel ask for a position past the end of the scroll,
          // and asking to go somewhere unreachable is how an autoplay ends up
          // sitting still for good.
          const landing = Math.max(
            0,
            Math.min(restingPosition(item), maxScroll),
          );
          const distance = landing - scrollLeft;
          const threshold = item.offsetWidth * MIN_AUTOPLAY_STEP;
          return direction === "forwards"
            ? distance > threshold
            : distance < -threshold;
        };
        const target =
          direction === "forwards"
            ? items.find(isWorthGoingTo)
            : [...items].reverse().find(isWorthGoingTo);
        if (!target) {
          return false;
        }
        scrollIntoView(target, container, edgeFor(target));
        return true;
      },
      [boundaryOffset, loop, scrollIntoView, viewportRef],
    );

    /**
     * Scrolls the container to the next slide until hitting the end of the
     * container. How far that is depends on the mode, `page` by default.
     */
    const handleScrollToNext = useCallback(
      (mode: CarouselScrollMode = "page") => {
        if (mode === "item") {
          scrollToAdjacentItem("forwards");
          return;
        }
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
          if (mode === "viewport" || items.length === 1) {
            handleScrollPage("forwards", container, items, {
              alignToItem: mode !== "viewport",
            });
            return;
          }
          const currentScroll = container.scrollLeft;
          const containerOffsetWidth = container.offsetWidth;
          const { x: boundaryOffsetX } = getBoundaryOffset(
            boundaryOffset,
            root,
          );
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
      },
      [
        boundaryOffset,
        clearAnimation,
        handleScrollPage,
        loop,
        scrollToAdjacentItem,
        viewportRef,
        scrollIntoView,
        scrollStateRef,
      ],
    );

    /**
     * Scrolls the container to the previous slide until hitting the start of
     * the container. How far that is depends on the mode, `page` by default.
     */
    const handleScrollToPrev = useCallback(
      (mode: CarouselScrollMode = "page") => {
        if (mode === "item") {
          scrollToAdjacentItem("backwards");
          return;
        }
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
          if (mode === "viewport" || items.length === 1) {
            handleScrollPage("backwards", container, items, {
              alignToItem: mode !== "viewport",
            });
            return;
          }
          const currentScroll = container.scrollLeft;
          const { x: boundaryOffsetX } = getBoundaryOffset(
            boundaryOffset,
            root,
          );
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
      },
      [
        boundaryOffset,
        clearAnimation,
        handleScrollPage,
        loop,
        scrollToAdjacentItem,
        viewportRef,
        scrollIntoView,
        scrollStateRef,
      ],
    );

    /**
     * Moves by exactly one item. This is what `mode: "item"` asks for, on a
     * button or on the autoplay: `page`, the default, moves by a viewport worth
     * of items at a time instead.
     */

    // Read the autoplay options out one at a time rather than handing the object
    // to the effect: it is nearly always written inline, so its identity changes
    // on every render and the effect would spend its life being torn down and
    // set back up — restarting the animation and thrashing scroll-snap-type
    // several times a second.
    // The options a given shape does not offer are typed as the reason why, so
    // that the compiler quotes it back at whoever passes one (see NoAtEnd and
    // friends). None of them can get this far, so read the lot as what they
    // actually are.
    const autoplayConfig = (
      typeof autoplay === "object" ? autoplay : {}
    ) as ResolvedAutoplayOptions;
    const autoplayEnabled = autoplay !== false;
    const autoplayMode = autoplayConfig.mode ?? "item";
    const autoplaySpeed =
      autoplayConfig.mode === "continuous" ? (autoplayConfig.speed ?? 60) : 60;
    const autoplayInterval =
      autoplayConfig.mode === "continuous"
        ? 3000
        : (autoplayConfig.interval ?? 3000);
    const autoplayPauseAtEnd =
      autoplayConfig.mode === "continuous"
        ? (autoplayConfig.pauseAtEnd ?? 0)
        : 0;
    const autoplayDirection = autoplayConfig.direction ?? "forwards";
    const autoplayAtEnd = autoplayConfig.atEnd ?? "rewind";
    const autoplayPauseOnHover = autoplayConfig.pauseOnHover ?? true;
    const autoplayPauseOnFocus = autoplayConfig.pauseOnFocus ?? true;
    const autoplayPauseOnInteraction =
      autoplayConfig.pauseOnInteraction ?? AUTOPLAY_RESUME_DELAY;

    /**
     * Puts the numbers the viewport has just measured onto the root.
     *
     * The viewport does this itself every time it scrolls, but it cannot on the
     * pass that mounts it: React commits children before their parents, so at
     * that point the root element it would write to does not exist yet. This is
     * that write, once the whole tree is in place, and being a layout effect it
     * still lands before anything is painted.
     */
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const { x: offsetX } = getBoundaryOffset(boundaryOffset, root);
      root.style.setProperty(CSS_VARS.scrollMarginInline, `${offsetX}px`);
      root.style.setProperty(
        CSS_VARS.remainingForwards,
        `${remainingForwards.current}px`,
      );
      root.style.setProperty(
        CSS_VARS.remainingBackwards,
        `${remainingBackwards.current}px`,
      );
    });

    /**
     * Scrolls the carousel on its own, and gets out of the way the moment
     * anything else wants the scroll: the pointer resting on it, the focus
     * moving into it, a drag, a wheel, or a momentum still running.
     */
    useEffect(() => {
      const root = rootRef.current;
      const state = scrollStateRef?.current;
      if (!autoplayEnabled || !root || !state) {
        return;
      }
      const reducedMotionQuery = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      );

      /** everything with a claim on the scroll, by name so they can stack */
      const pausedBy = new Set<string>();
      let frame: MaybeNull<number> = null;
      let timer: MaybeUndefined<ReturnType<typeof setInterval>> = undefined;
      let lastFrameTime = 0;
      /** which way we are going: `atEnd: "reverse"` turns this around */
      let sign = autoplayDirection === "backwards" ? -1 : 1;
      /** where a rewind is heading, while it is on its way there */
      let rewindingTo: MaybeNull<number> = null;
      /** running while we sit at the end, before `atEnd` takes over */
      let endPause: MaybeUndefined<ReturnType<typeof setTimeout>> = undefined;

      /** the user is doing something with the carousel: leave it alone */
      const isBusy = () =>
        state.isDragging ||
        state.isPointerDown ||
        state.animationId !== null ||
        Date.now() - state.lastWheelTime < WHEEL_GESTURE_TIMEOUT;

      const canAdvance = () => {
        if (loop) {
          return true;
        }
        const remaining =
          sign > 0 ? remainingForwards.current : remainingBackwards.current;
        return remaining > 1;
      };

      /**
       * Still on the way back to the end we came from, so leave the scroll to
       * the animation doing the rewinding.
       */
      const isRewinding = () => {
        const container = viewportRef.current;
        if (rewindingTo === null || !container) {
          return false;
        }
        if (Math.abs(container.scrollLeft - rewindingTo) <= 1) {
          rewindingTo = null;
          lastFrameTime = 0;
          return false;
        }
        return true;
      };

      /** Turn around, or go back to the end we started from */
      const applyAtEnd = () => {
        const container = viewportRef.current;
        if (!container) {
          return;
        }
        if (autoplayAtEnd === "reverse") {
          sign = -sign;
          lastFrameTime = 0;
          return;
        }
        rewindingTo =
          sign > 0 ? 0 : container.scrollWidth - container.clientWidth;
        container.scrollTo({
          left: rewindingTo,
          behavior: resolveScrollBehavior("smooth", state),
        });
      };

      /**
       * A carousel that does not loop has run out of content. Sit there for a
       * moment if asked to — running headlong into the end and turning round in
       * the same frame reads as a bounce — then turn around, go back to the end
       * we started from, or call it a day.
       */
      const handleEnd = () => {
        const container = viewportRef.current;
        // nowhere to go in either direction: there is nothing to play
        if (
          !container ||
          autoplayAtEnd === "stop" ||
          (remainingForwards.current <= 1 && remainingBackwards.current <= 1)
        ) {
          stop();
          return;
        }
        if (!autoplayPauseAtEnd) {
          applyAtEnd();
          return;
        }
        // the frames keep coming while we sit here, so only ever wait once
        if (endPause === undefined) {
          endPause = setTimeout(() => {
            endPause = undefined;
            applyAtEnd();
          }, autoplayPauseAtEnd);
        }
      };

      /** give the scroll back to the browser, snapping and all */
      const releaseScroll = () => {
        const container = viewportRef.current;
        if (
          container &&
          autoplayMode === "continuous" &&
          !state.isWheelSnapSuspended
        ) {
          container.style.scrollSnapType = state.scrollSnapType;
        }
      };

      const setPaused = (reason: string, paused: boolean) => {
        const wasPaused = pausedBy.size > 0;
        if (paused) {
          pausedBy.add(reason);
        } else {
          pausedBy.delete(reason);
        }
        const isPaused = pausedBy.size > 0;
        if (isPaused !== wasPaused) {
          root.dataset.carouselAutoplay = isPaused ? "paused" : "playing";
          if (isPaused) {
            // hand snapping back so the carousel settles onto an item while the
            // user has it, rather than sitting between two of them
            releaseScroll();
          } else {
            lastFrameTime = 0;
          }
        }
      };

      const scrollContinuously = (time: number) => {
        frame = requestAnimationFrame(scrollContinuously);
        const container = viewportRef.current;
        const elapsed = lastFrameTime ? time - lastFrameTime : 0;
        lastFrameTime = time;
        if (
          !container ||
          pausedBy.size > 0 ||
          isBusy() ||
          !elapsed ||
          isRewinding()
        ) {
          // someone else is driving: pick up their position rather than carrying
          // on from where we left off
          if (container) {
            state.scrollLeft = container.scrollLeft;
          }
          return;
        }
        if (!canAdvance()) {
          handleEnd();
          return;
        }
        // snapping would pull every frame back onto the nearest item, which is
        // the opposite of scrolling continuously
        container.style.scrollSnapType = "none";
        state.scrollLeft += (sign * autoplaySpeed * elapsed) / 1000;
        container.scrollLeft = state.scrollLeft;
      };

      const step = () => {
        if (pausedBy.size > 0 || isBusy() || isRewinding()) {
          return;
        }
        if (!canAdvance()) {
          handleEnd();
          return;
        }
        const direction = sign > 0 ? "forwards" : "backwards";
        // `continuous` scrolls by the frame and never comes through here, so
        // whatever is left is a mode the buttons understand
        const stepMode: CarouselScrollMode =
          autoplayMode === "continuous" ? "item" : autoplayMode;
        if (stepMode === "item") {
          // asked for separately rather than through the buttons: this is the
          // one that can say there is no item left to step onto, whatever the
          // remaining scroll distance says
          if (!scrollToAdjacentItem(direction)) {
            handleEnd();
          }
        } else if (direction === "forwards") {
          // the same move the next button makes, in the same mode
          handleScrollToNext(stepMode);
        } else {
          handleScrollToPrev(stepMode);
        }
      };

      const stop = () => {
        if (frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
        clearInterval(timer);
        timer = undefined;
        clearTimeout(endPause);
        endPause = undefined;
        rewindingTo = null;
        releaseScroll();
        delete root.dataset.carouselAutoplay;
      };

      const start = () => {
        stop();
        if (reducedMotionQuery?.matches && reducedMotion === "respect") {
          // things moving about on their own is the first thing someone asking
          // for reduced motion does not want
          return;
        }
        root.dataset.carouselAutoplay =
          pausedBy.size > 0 ? "paused" : "playing";
        lastFrameTime = 0;
        if (autoplayMode === "continuous") {
          frame = requestAnimationFrame(scrollContinuously);
        } else {
          timer = setInterval(step, autoplayInterval);
        }
      };

      const pauseHover = () => setPaused("hover", true);
      const resumeHover = () => setPaused("hover", false);
      const pauseFocus = () => setPaused("focus", true);
      const resumeFocus = () => setPaused("focus", false);
      // The wait starts when the carousel comes to rest, not when the gesture
      // ends: letting go of a drag hands over to the momentum animation, and
      // the last flick of a wheel to whatever snapping the browser still has to
      // do, so what the user let go of goes on moving for a while yet. Picking
      // up before then takes the carousel away mid-glide, which is the very
      // thing the pause is for.
      let resumeTimeout: MaybeUndefined<ReturnType<typeof setTimeout>>;
      /** the gesture is over, and we are waiting on where it leaves us */
      let isSettling = false;
      const holdForInteraction = () => {
        clearTimeout(resumeTimeout);
        isSettling = false;
        setPaused("interaction", true);
      };
      const releaseAfterInteraction = () => {
        clearTimeout(resumeTimeout);
        isSettling = true;
        resumeTimeout = setTimeout(() => {
          // Still going under its own steam: a rubber band springing back, or a
          // wheel gesture that has not timed out yet. Neither makes scroll
          // events of its own to wait on, so the wait simply starts again.
          if (isBusy()) {
            releaseAfterInteraction();
            return;
          }
          isSettling = false;
          setPaused("interaction", false);
        }, autoplayPauseOnInteraction || AUTOPLAY_RESUME_DELAY);
      };
      const handleInteraction = () => {
        holdForInteraction();
        releaseAfterInteraction();
      };
      /**
       * Momentum, snapping and the loop's own corrections all arrive as scrolls
       * after the user has finished. Each one puts the wait back, so what the
       * countdown runs from is the position the carousel settles on rather than
       * the moment the hand left it.
       */
      const handleInteractionScroll = () => {
        if (isSettling && !state.isPointerDown) {
          releaseAfterInteraction();
        }
      };
      const handleVisibility = () =>
        setPaused("hidden", document.visibilityState === "hidden");

      start();
      if (autoplayPauseOnHover) {
        root.addEventListener("mouseenter", pauseHover);
        root.addEventListener("mouseleave", resumeHover);
      }
      // Focus is watched on the viewport rather than the whole carousel: it is
      // the content moving under a reader that pausing is meant to prevent, and
      // whatever buttons and controls sit alongside the viewport are usually
      // still focused long after they have been used — which would leave the
      // carousel paused for good.
      const viewport = viewportRef.current ?? root;
      if (autoplayPauseOnFocus) {
        viewport.addEventListener("focusin", pauseFocus);
        viewport.addEventListener("focusout", resumeFocus);
      }
      // Only what the user did directly: the autoplay's own scrolling would
      // otherwise keep pausing the autoplay.
      if (autoplayPauseOnInteraction !== false) {
        viewport.addEventListener("wheel", handleInteraction, {
          passive: true,
        });
        viewport.addEventListener("pointerdown", holdForInteraction);
        viewport.addEventListener("scroll", handleInteractionScroll, {
          passive: true,
        });
        document.addEventListener("pointerup", releaseAfterInteraction);
        document.addEventListener("pointercancel", releaseAfterInteraction);
      }
      document.addEventListener("visibilitychange", handleVisibility);
      reducedMotionQuery?.addEventListener("change", start);

      return () => {
        stop();
        clearTimeout(resumeTimeout);
        root.removeEventListener("mouseenter", pauseHover);
        root.removeEventListener("mouseleave", resumeHover);
        viewport.removeEventListener("focusin", pauseFocus);
        viewport.removeEventListener("focusout", resumeFocus);
        viewport.removeEventListener("wheel", handleInteraction);
        viewport.removeEventListener("pointerdown", holdForInteraction);
        viewport.removeEventListener("scroll", handleInteractionScroll);
        document.removeEventListener("pointerup", releaseAfterInteraction);
        document.removeEventListener("pointercancel", releaseAfterInteraction);
        document.removeEventListener("visibilitychange", handleVisibility);
        reducedMotionQuery?.removeEventListener("change", start);
      };
    }, [
      autoplayAtEnd,
      autoplayDirection,
      autoplayEnabled,
      autoplayInterval,
      autoplayMode,
      autoplayPauseAtEnd,
      autoplayPauseOnFocus,
      autoplayPauseOnHover,
      autoplayPauseOnInteraction,
      autoplaySpeed,
      handleScrollToNext,
      handleScrollToPrev,
      loop,
      reducedMotion,
      scrollStateRef,
      scrollToAdjacentItem,
      viewportRef,
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

CarouselRootImpl.displayName = "Carousel.Root";

/**
 * `forwardRef` hands back a plain component, which has nowhere to put the type
 * argument that `loop` needs to infer into, so the signature is restated here.
 * Nothing about the component changes — this is the same object, described in
 * the one way that lets `loop` decide which autoplay options come with it.
 *
 * `Loop` defaults to `false` rather than to the type's own `boolean`, so that
 * leaving `loop` off gets the carousel that can reach an end, `atEnd` and all.
 */
const CarouselRoot = CarouselRootImpl as (<Loop extends boolean = false>(
  props: CarouselRootProps<Loop> & RefAttributes<HTMLDivElement>,
) => ReactElement) & { displayName?: string };

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
      focusScrollDestination: null,
      isFocusScrolling: false,
      isPointerDown: false,
      isWheelSnapSuspended: false,
      ignoresReducedMotion: false,
      lastScrollLeft: 0,
      lastWheelTime: 0,
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
     * Hands snapping back to the browser whenever nothing of ours is holding on
     * to it. React will not do this for us: we write to the same inline style it
     * set, which it has no idea about, so as far as it is concerned the value it
     * last rendered is still there and there is nothing to update. Turning
     * `loop` off mid-scroll would otherwise leave the viewport stuck on
     * `scroll-snap-type: none`, with the carousel still snapping by hand.
     */
    useLayoutEffect(() => {
      const container = viewportRef.current;
      const state = scrollStateRef.current;
      if (!container || state.isDragging || state.animationId !== null) {
        return;
      }
      if (!loop) {
        // there is nothing left to protect a wheel scroll from
        state.isWheelSnapSuspended = false;
      }
      if (!state.isWheelSnapSuspended) {
        container.style.scrollSnapType = state.scrollSnapType;
      }
    }, [loop, scrollSnapType]);

    /**
     * Determine whether the container can scroll forwards or backwards based on
     * its current scroll position, offset width, and scroll width. Updates
     * relevant state and CSS variables.
     */
    const updateScrollState = useCallback(() => {
      const container = viewportRef.current;
      if (container) {
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
        // The custom properties live on the root, whose ref React attaches
        // after ours — it commits children first — so on the very first pass
        // there is nothing to set them on yet. The numbers above are what the
        // buttons and the loop read, and they are worth having either way.
        const root = rootRef.current;
        if (root) {
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
      // This jump is about to pull the ground out from under whatever scroll the
      // browser is running. If that scroll is a wheel one it was steering
      // towards a snap point, and losing that target goes badly: Safari swallows
      // the rest of the momentum without moving, Firefox drops the snap it was
      // going to end on. So the moment we disturb one, we take snapping off it
      // and give it back ourselves once everything stops (see settleWheelSnap).
      // Only then: a scroll that never runs out of content keeps the browser's
      // own snapping from end to end. (In Chromium the wheel handler has already
      // taken it, for reasons explained there, so this is a no-op.)
      const isBrowserScrolling =
        Date.now() - state.lastWheelTime < WHEEL_GESTURE_TIMEOUT;
      const takesOverSnapping =
        !!state.scrollSnapType &&
        isBrowserScrolling &&
        !state.isWheelSnapSuspended &&
        !state.isDragging &&
        state.animationId === null;
      if (takesOverSnapping) {
        state.isWheelSnapSuspended = true;
        container.style.scrollSnapType = "none";
      }
      // The item the browser had snapped to is now a whole set of copies away
      // from the viewport. Chromium holds on to it and, the next time it gets to
      // snap, scrolls all the way back to it — content flying past for hundreds
      // of milliseconds. Making it re-pick from where we land keeps it on the
      // copy the user is actually looking at.
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
     * actually going there. Snapping is left off, the way the interrupted scroll
     * wants it — settleWheelSnap hands it back when it is done.
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
     * Gives back the snapping a wrap had to take away, once the scroll it
     * interrupted has come to a stop: the carousel animates to the position the
     * user's snapping asks for, and only then does the browser get to snap
     * again. Animating it ourselves is the point — the browser would otherwise
     * do it against the momentum it is still running, or against the item it had
     * snapped to before the wrap moved it a whole set of copies away.
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
        container.scrollTo({
          left: snapped,
          behavior: resolveScrollBehavior("smooth", state),
        });
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
          // whatever the focus was heading for has arrived
          scrollStateRef.current.focusScrollDestination = null;
          // the loop moves first: it teleports, which the snapping animation
          // would otherwise have to be restarted for
          settleLoopScroll();
          settleWheelSnap();
        };
        const handleScroll = () => {
          const wrapped = wrapLoopScroll();
          const heading = scrollStateRef.current.focusScrollDestination;
          // Every engine, not just Chromium: a scroll cut short mid-glide ends
          // up somewhere that is no snap point in any of them, and they all
          // correct for that in their own way. What matters is that the journey
          // finishes where it was going, which is not an engine's opinion.
          if (wrapped && heading !== null) {
            // The wrap moved the content by whole copies and cut the scroll
            // short wherever it happened to be — which is no snap point, and a
            // `mandatory` carousel then drags itself back to the nearest one.
            // Sending it on to the same place, a copy along, keeps the journey
            // and lands it where it was always going.
            scrollStateRef.current.focusScrollDestination = heading + wrapped;
            container.scrollTo({
              left: heading + wrapped,
              behavior: resolveScrollBehavior("smooth", scrollStateRef.current),
            });
          }
          scrollStateRef.current.lastScrollLeft = container.scrollLeft;
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
        // The custom properties this measures for cannot be written yet: the
        // root is committed after us and has no element to take them. It sets
        // them itself in a layout effect of its own, once everything is there.
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
    const lastTab =
      useRef<MaybeNull<{ scrollLeft: number; backwards: boolean }>>(null);

    /**
     * Scroll to the focused element into view if it's not already visible
     */
    const handleFocus = useCallback(
      (event: FocusEvent) => {
        const container = viewportRef.current;
        const { target, relatedTarget } = event;
        if (
          container &&
          target instanceof HTMLElement &&
          target !== event.currentTarget &&
          // the loop just handed the focus to the copy on screen: that is where
          // the user is already looking, and scrolling to it is what turns a few
          // pixels of overhang into a jump to the previous snap point
          !isRelocatingLoopFocus
        ) {
          const tab = lastTab.current;
          // spent here, so that a focus we move ourselves below comes back
          // round as an ordinary one rather than as another tab
          lastTab.current = null;
          if (tab) {
            // Undo the jump the browser made to reveal the newly focused
            // element — but never past where the carousel has already got to.
            // The position was taken on the keypress, and by the time the focus
            // lands the browser may have moved on from it; winding back to it
            // then drags the carousel backwards while the user tabs forwards,
            // which is what a fast tab looks like. Tab slowly and the two are
            // the same position, so this changes nothing.
            //
            // A carousel snapping `mandatory` may well decline this: it
            // re-snaps whatever is set on it, and taking snapping off for the
            // write does not help either, since handing it back snaps the
            // position just the same. What it can do is not make things worse.
            container.scrollLeft = tab.backwards
              ? Math.min(tab.scrollLeft, container.scrollLeft)
              : Math.max(tab.scrollLeft, container.scrollLeft);
            // Tabbing in from outside lands on whatever comes first in the
            // DOM, which after any amount of scrolling is somewhere back at the
            // beginning — and going to fetch it drags the carousel all the way
            // there. What the user meant was the thing they can see, so the
            // focus is handed to the first of those instead and nothing moves.
            // The viewport itself does not count as being inside. Firefox makes
            // a scrollable box focusable so it can be scrolled with the arrow
            // keys, which puts a tab stop on the carousel before any of its
            // contents: coming from there is still coming in from outside, and
            // treating it otherwise leaves the arrival to fend for itself — the
            // one browser where tabbing in still went to fetch the first child.
            const cameFromOutside = !(
              relatedTarget instanceof Node &&
              relatedTarget !== container &&
              container.contains(relatedTarget)
            );
            if (cameFromOutside && !isWithinScrollport(target, container)) {
              const onScreen = getTabbableElements(container).filter(
                (element) => isWithinScrollport(element, container),
              );
              // shift-tabbing arrives at the far end, so it starts from the
              // last thing on screen rather than the first
              const candidate = tab.backwards
                ? onScreen[onScreen.length - 1]
                : onScreen[0];
              if (candidate && candidate !== target) {
                const held = container.scrollLeft;
                focusWithoutScrolling(candidate);
                // Firefox goes to fetch the element that first took the focus
                // after handing us the event rather than before it, so the
                // position it was told about has to be held for a frame.
                requestAnimationFrame(() => {
                  if (Math.abs(container.scrollLeft - held) > 1) {
                    container.scrollLeft = held;
                  }
                });
                return;
              }
            }
            // a looping carousel can bring the element the tab order moved to
            // round to the near side, rather than travelling to where it
            // happens to sit: whole copies cost nothing to cross, so only the
            // remainder is left for the animation below
            teleportTowardsFocus(container, target, tab.backwards);
            // it handed the focus to a copy within reach instead of moving the
            // scroll: that focus has been dealt with on its own terms, and
            // showing this one now would undo the whole point of it
            if (document.activeElement !== target) {
              return;
            }
          }
          // anything still remembered belongs to a scroll that has been and
          // gone; this focus decides afresh whether there is one to follow
          scrollStateRef.current.focusScrollDestination = null;
          scrollStateRef.current.isFocusScrolling = !!tab;
          scrollIntoView(target, container, "nearest");
          scrollStateRef.current.isFocusScrolling = false;
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
      // recorded wherever the focus currently is, since the press that carries
      // it into the carousel comes from outside of it — that one has the
      // furthest to travel, and the most to gain from crossing copies for free
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          lastTab.current = {
            scrollLeft: container.scrollLeft,
            backwards: event.shiftKey,
          };
        }
      };

      // the focus lands between the press and its release, so anything still
      // pending by the time the key comes back up belongs to a tab that went
      // elsewhere entirely, and must not be spent on the next click in here
      const handleKeyUp = (event: KeyboardEvent) => {
        if (event.key === "Tab") {
          lastTab.current = null;
        }
      };

      container.addEventListener("focus", handleFocus, { capture: true });
      document.addEventListener("keydown", handleKeyDown);
      document.addEventListener("keyup", handleKeyUp);
      return () => {
        container.removeEventListener("focus", handleFocus, { capture: true });
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("keyup", handleKeyUp);
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
          state.lastWheelTime = Date.now();
          // The browser is left to do its own snapping for as long as it is
          // scrolling in peace, and the carousel only takes over once a wrap has
          // moved the ground under it (see wrapLoopScroll). Chromium is the
          // exception: it commits to a snap target when the gesture starts and
          // steers towards it the whole way, so by the time a wrap comes it is
          // already too late to take it off — the jump yanks the scroll back to
          // a target that is now a set of copies away. There, the whole gesture
          // runs unsnapped. Either way settleWheelSnap gives snapping back, and
          // until it does nothing here puts it on again.
          //
          // None of which applies without `loop`: nothing is ever going to move
          // the ground under the browser, so its snapping is left well alone.
          if (state.scrollSnapType && loop && getIsChromium()) {
            state.isWheelSnapSuspended = true;
            event.currentTarget.style.scrollSnapType = "none";
          } else if (!state.isWheelSnapSuspended) {
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
    const { loop, scrollStateRef } = useCarouselContext();
    const [duplicates, setDuplicates] = useState(0);
    const hasPositionedRef = useRef(false);
    const loopMetricsRef = useRef<MaybeNull<LoopMetrics>>(null);
    /**
     * Where the scroll was when looping was turned on, before anything had a
     * chance to move it. The copies land in the DOM over two renders and the
     * viewport may wrap the scroll in between, so the position cannot simply be
     * read back when it is time to use it.
     */
    const scrollLeftBeforeCopiesRef = useRef<MaybeNull<number>>(null);
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
        const metrics = loopMetricsRef.current;
        const first = content.children[0];
        if (
          metrics &&
          hasPositionedRef.current &&
          first instanceof HTMLElement
        ) {
          // The copies have just gone from under the scroll position. Whatever
          // the user was looking at is still here — once — so put the scroll at
          // the matching spot in what is left, and nothing appears to move.
          const origin = getOffsetLeft(first, viewport);
          const { naturalWidth } = metrics;
          const withinCopy =
            ((((scrollStateRef?.current?.lastScrollLeft ?? 0) - origin) %
              naturalWidth) +
              naturalWidth) %
            naturalWidth;
          setLoopScrollLeft(viewport, origin + withinCopy, {
            reselectSnapTarget: true,
          });
        }
        hasPositionedRef.current = false;
        loopMetricsRef.current = null;
        scrollLeftBeforeCopiesRef.current = null;
        if (duplicates !== 0) {
          // cleanup previous duplicates if needed
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setDuplicates(0);
        }
        return;
      }

      // This effect runs before the viewport's, so on the render that turns
      // looping on the scroll has not been touched yet: this is the last chance
      // to see where the user was.
      if (scrollLeftBeforeCopiesRef.current === null) {
        scrollLeftBeforeCopiesRef.current = viewport.scrollLeft;
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
          // A whole set of copies has just been inserted in front of whatever
          // was on screen, so everything sits one set further along than it
          // did: move with it and nothing appears to shift. On a fresh mount
          // the scroll is at nought, which lands on the first original child —
          // it opens the middle set. Doing this in a layout effect means the
          // browser paints the carousel there, no scrolling is ever shown.
          setLoopScrollLeft(
            viewport,
            (scrollLeftBeforeCopiesRef.current ?? 0) + metrics.setWidth,
            { reselectSnapTarget: true },
          );
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
    }, [childrenCount, duplicates, loop, scrollStateRef]);

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

type CarouselNextPageProps = ComponentPropsWithoutRef<"button"> & {
  /** How far a click goes. `"page"` by default, see {@link CarouselScrollMode} */
  mode?: CarouselScrollMode;
};

const CarouselNextPage = forwardRef<HTMLButtonElement, CarouselNextPageProps>(
  ({ children, onClick, disabled, mode, ...props }, ref) => {
    const { scrollsForwards, handleScrollToNext } = useContext(CarouselContext);

    return (
      <button
        ref={ref}
        {...props}
        onClick={(event) => {
          handleScrollToNext(mode);
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

type CarouselPrevPageProps = ComponentPropsWithoutRef<"button"> & {
  /** How far a click goes. `"page"` by default, see {@link CarouselScrollMode} */
  mode?: CarouselScrollMode;
};

const CarouselPrevPage = forwardRef<HTMLButtonElement, CarouselPrevPageProps>(
  ({ children, onClick, disabled, mode, ...props }, ref) => {
    const { scrollsBackwards, handleScrollToPrev } =
      useContext(CarouselContext);

    return (
      <button
        ref={ref}
        {...props}
        onClick={(event) => {
          handleScrollToPrev(mode);
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
  // Anything already slower than the floor coasts nowhere, and the arithmetic
  // below cannot say so: it counts the frames it takes to decelerate *down* to
  // minVelocity, which for something slower than that is a negative number of
  // them. A pointer that never moved makes it worse — dividing by a velocity of
  // zero counts infinitely many frames, and `0 * Infinity` is `NaN`. Assigning
  // that to `scrollLeft` reads as 0, which a looping carousel then rescues by
  // wrapping: a click, and the carousel is back on its first item.
  if (decelerationFactor >= 1 || !(Math.abs(velocity) >= minVelocity)) {
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

  // a deceleration that barely decelerates can still run the sum out of range
  if (!Number.isFinite(finalScroll)) {
    return { finalScroll: initialScroll, iterations: 0 };
  }

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

/**
 * The types, exported flat. These are the canonical names — the namespace
 * further down is sugar over this list, not a separate API. Anything that
 * cannot see through a namespace (isolated declarations, some `.d.ts`
 * bundlers) still has a way to name every prop type.
 */
export type {
  CarouselAutoplayAtEnd,
  CarouselAutoplayDirection,
  CarouselAutoplayMode,
  CarouselAutoplayOptions,
  CarouselAutoplayStepMode,
  CarouselBoundaryOffset,
  CarouselContentProps,
  CarouselContext,
  CarouselItemProps,
  CarouselNextPageProps,
  CarouselPrevPageProps,
  CarouselReducedMotion,
  CarouselRootProps,
  CarouselScrollMode,
  CarouselViewportProps,
};

// the namespace below merges its types onto this object, which the import
// plugin reads as a second export of the same name
// eslint-disable-next-line import/export
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

/**
 * The types that go with the components, kept under the same name so that
 * anything built on top of the carousel can reach them without a second import:
 * `Carousel.AutoplayMode`, `Carousel.RootProps`, and so on. Types only — this
 * merges with the object above rather than adding anything to it.
 */
// Merging types onto the component object is the one thing a namespace is still
// the right tool for: there is no module syntax that puts `Carousel.RootProps`
// next to `Carousel.Root`. Nothing is emitted for it.
// eslint-disable-next-line @typescript-eslint/no-namespace, import/export
export declare namespace Carousel {
  /**
   * `Loop` says whether the carousel loops, which is what decides the autoplay
   * options that come with it. Left off, it covers either kind — the same set
   * of props the type has always described.
   */
  export type RootProps<Loop extends boolean = boolean> =
    CarouselRootProps<Loop>;
  export type ViewportProps = CarouselViewportProps;
  export type ContentProps = CarouselContentProps;
  export type ItemProps = CarouselItemProps;
  export type PrevPageProps = CarouselPrevPageProps;
  export type NextPageProps = CarouselNextPageProps;

  /**
   * `CanEnd` says whether the carousel is one that can run out of content,
   * which is the only time the `atEnd` options are on offer — a looping
   * carousel never reaches an end. Follows `loop`, so it is `false` by default.
   */
  export type AutoplayOptions<CanEnd extends boolean = false> =
    CarouselAutoplayOptions<CanEnd>;
  export type AutoplayMode = CarouselAutoplayMode;
  export type AutoplayStepMode = CarouselAutoplayStepMode;
  export type AutoplayDirection = CarouselAutoplayDirection;
  export type AutoplayAtEnd = CarouselAutoplayAtEnd;

  export type BoundaryOffset = CarouselBoundaryOffset;
  /** What to do about `prefers-reduced-motion: reduce` */
  export type ReducedMotion = CarouselReducedMotion;
  /** How far one prev / next move goes */
  export type ScrollMode = CarouselScrollMode;
  /** What `Carousel.useCarouselContext()` hands back */
  export type Context = CarouselContext;
}
