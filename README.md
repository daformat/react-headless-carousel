# React headless carousel

A react headless carousel component: scrollable, and swipeable carousel, even on desktop, complete with snapping,
friction, rubber-banding and overscroll.

## Installation

```bash
npm install @daformat/react-headless-carousel
```

```bash
yarn add @daformat/react-headless-carousel
```

```bash
pnpm add @daformat/react-headless-carousel

```

```bash
bun add @daformat/react-headless-carousel
```

```bash
deno add npm:@daformat/react-headless-carousel
```

## Demo

https://hello-mat.com/design-engineering/component/carousel-component

## Component structure

```tsx
/* Provides context to the carousel components */
<Carousel.Root>
  {/* The scrollable area */}
  <Carousel.Viewport>
    {/* The container for the items */}
    <Carousel.Content>
      {/* A carousel item */}
      <Carousel.Item />
      <Carousel.Item />
      <Carousel.Item />
    </Carousel.Content>
  </Carousel.Viewport>
  {/* The pagination buttons */}
  <Carousel.PrevPage />
  <Carousel.NextPage />
</Carousel.Root>
```

## Components

### `Carousel.Root`

The outermost wrapper. Provides context to all child carousel components. Renders a `<div>`.

| Prop             | Type                                                                            | Default                 | Description                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundaryOffset` | `{ x: number; y: number } \| ((root: HTMLElement) => { x: number; y: number })` | `defaultBoundaryOffset` | Inset in pixels from the leading and trailing edges of the viewport used when scrolling items into view with prev/next buttons. The default implementation reads the content fade size from the viewport so items are never scrolled behind the fade. Pass a plain object or a function receiving the root element and returning `{ x, y }` to override. |
| `ref`            | `Ref<HTMLDivElement>`                                                           | —                       | Forwarded ref to the root `<div>`.                                                                                                                                                                                                                                                                                                                       |
| `...props`       | `ComponentPropsWithoutRef<"div">`                                               | —                       | All standard `<div>` props (`className`, `style`, `children`, etc.).                                                                                                                                                                                                                                                                                     |

---

### `Carousel.Viewport`

The scrollable container. Handles pointer/mouse dragging, momentum, rubber-banding, scroll-snapping, and keyboard focus
scrolling. Renders a `<div>` with `overflow: scroll` and hidden scrollbars.

| Prop              | Type                              | Default                     | Description                                                                                                                                                                     |
| ----------------- | --------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrollSnapType`  | `CSSProperties["scrollSnapType"]` | —                           | CSS `scroll-snap-type` value applied to the container (e.g. `"x mandatory"`). Snapping is coordinated with the momentum animation so the carousel always lands on a snap point. |
| `contentFade`     | `boolean`                         | `true`                      | When `true`, a mask-image fade is applied to both edges of the viewport. The fade appears only when there is scrollable content in that direction.                              |
| `contentFadeSize` | `string \| number`                | `"clamp(16px, 10vw, 64px)"` | Width of the content fade. Accepts any CSS length string or a `number` (interpreted as `px`). Only valid when `contentFade` is `true` (or omitted).                             |
| `ref`             | `Ref<HTMLDivElement>`             | —                           | Forwarded ref to the viewport `<div>`.                                                                                                                                          |
| `...props`        | `ComponentPropsWithoutRef<"div">` | —                           | All standard `<div>` props. Event handlers `onPointerDown`, `onPointerMove`, `onPointerUp`, `onClickCapture`, and `onWheel` are merged with the internal handlers.              |

#### Data attributes set on the viewport

| Attribute                | Values                                                | Description                                                                                                |
| ------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `data-carousel-viewport` | `""`                                                  | Always present. Used internally for boundary offset calculation.                                           |
| `data-can-scroll`        | `"forwards"` \| `"backwards"` \| `"both"` \| `"none"` | Reflects the current scrollability. Useful for styling buttons or indicators with CSS attribute selectors. |

---

### `Carousel.Content`

A thin wrapper that sets `width: fit-content` so items lay out in a single row. Renders a `<div>`.

| Prop       | Type                              | Default | Description                                                              |
| ---------- | --------------------------------- | ------- | ------------------------------------------------------------------------ |
| `ref`      | `Ref<HTMLDivElement>`             | —       | Forwarded ref to the content `<div>`.                                    |
| `...props` | `ComponentPropsWithoutRef<"div">` | —       | All standard `<div>` props. Styles are merged with `width: fit-content`. |

---

### `Carousel.Item`

A single carousel slide. By default renders a `<div>` with `will-change: transform` (required for the rubber-banding
animation). Use `asChild` to merge onto your own element.

| Prop       | Type                              | Default | Description                                                                                                                                                                                                          |
| ---------- | --------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asChild`  | `boolean`                         | `false` | When `true`, merges all props (including `data-carousel-item` and `style`) onto the single child element via `cloneElement` instead of rendering a wrapping `<div>`. The child must be a single valid React element. |
| `ref`      | `Ref<HTMLElement>`                | —       | Forwarded ref. When `asChild` is `true`, forwarded to the child element.                                                                                                                                             |
| `...props` | `ComponentPropsWithoutRef<"div">` | —       | All standard `<div>` props. `style` is merged with `will-change: transform`.                                                                                                                                         |

---

### `Carousel.NextPage`

A button that scrolls the carousel forwards by one page or to the next partially-visible item. Automatically disabled
when there is no more content to scroll forwards. Renders a `<button>`.

| Prop       | Type                                   | Default            | Description                                                                                                           |
| ---------- | -------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `disabled` | `boolean`                              | `!scrollsForwards` | Overrides the automatic disabled state. Pass `false` to always keep the button enabled regardless of scroll position. |
| `onClick`  | `MouseEventHandler<HTMLButtonElement>` | —                  | Called after the scroll action is triggered.                                                                          |
| `ref`      | `Ref<HTMLButtonElement>`               | —                  | Forwarded ref to the `<button>`.                                                                                      |
| `...props` | `ComponentPropsWithoutRef<"button">`   | —                  | All standard `<button>` props.                                                                                        |

---

### `Carousel.PrevPage`

A button that scrolls the carousel backwards by one page or to the previous partially-visible item. Automatically
disabled when the carousel is at the start. Renders a `<button>`.

| Prop       | Type                                   | Default             | Description                                  |
| ---------- | -------------------------------------- | ------------------- | -------------------------------------------- |
| `disabled` | `boolean`                              | `!scrollsBackwards` | Overrides the automatic disabled state.      |
| `onClick`  | `MouseEventHandler<HTMLButtonElement>` | —                   | Called after the scroll action is triggered. |
| `ref`      | `Ref<HTMLButtonElement>`               | —                   | Forwarded ref to the `<button>`.             |
| `...props` | `ComponentPropsWithoutRef<"button">`   | —                   | All standard `<button>` props.               |

---

## `Carousel.useCarouselContext`

A hook that provides access to the carousel's internal state and actions. Must be used inside `Carousel.Root`.

```tsx
const {
  scrollsForwards,
  scrollsBackwards,
  handleScrollToNext,
  handleScrollToPrev,
  scrollIntoView,
  remainingForwards,
  remainingBackwards,
  clearAnimation,
} = Carousel.useCarouselContext();
```

| Property                                       | Type                                                                                                       | Description                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scrollsForwards`                              | `boolean`                                                                                                  | `true` when the carousel has scrollable content ahead.                                                                                                                                                              |
| `scrollsBackwards`                             | `boolean`                                                                                                  | `true` when the carousel has scrollable content behind.                                                                                                                                                             |
| `remainingForwards`                            | `React.RefObject<number>`                                                                                  | Ref containing the number of pixels remaining to scroll forwards. Updated on every scroll event.                                                                                                                    |
| `remainingBackwards`                           | `React.RefObject<number>`                                                                                  | Ref containing the number of pixels remaining to scroll backwards.                                                                                                                                                  |
| `handleScrollToNext()`                         | `() => void`                                                                                               | Programmatically scroll to the next item/page, same as clicking `Carousel.NextPage`.                                                                                                                                |
| `handleScrollToPrev()`                         | `() => void`                                                                                               | Programmatically scroll to the previous item/page, same as clicking `Carousel.PrevPage`.                                                                                                                            |
| `scrollIntoView(target, container, direction)` | `(target: HTMLElement, container: HTMLElement, direction: "forwards" \| "backwards" \| "nearest") => void` | Scrolls `target` into view within `container`. `"nearest"` scrolls the minimum amount needed; `"forwards"` / `"backwards"` aligns the item to the leading or trailing edge, respecting `scroll-snap-align: center`. |
| `clearAnimation()`                             | `() => void`                                                                                               | Cancels any in-progress momentum animation.                                                                                                                                                                         |

---

## CSS custom properties

The following CSS custom properties are set on the root element and can be used for custom styling.

| Property                           | Description                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `--carousel-fade-size`             | Current fade size as resolved from `contentFadeSize`.                              |
| `--carousel-remaining-forwards`    | Pixels remaining to scroll forwards (e.g. `312px`). Updated on every scroll event. |
| `--carousel-remaining-backwards`   | Pixels remaining to scroll backwards.                                              |
| `--carousel-fade-offset-forwards`  | Fade offset at the forwards edge (used internally by the mask gradient).           |
| `--carousel-fade-offset-backwards` | Fade offset at the backwards edge.                                                 |
| `--carousel-scroll-margin-inline`  | The inline scroll margin for the carousel items                                    |

---

## Utilities

### `Carousel.defaultBoundaryOffset`

The default `boundaryOffset` function used by `Carousel.Root`. Reads `--carousel-fade-size` from the viewport element
and returns `{ x: fadeSize, y: 0 }` so that next/prev navigation never scrolls items behind the content fade. Exported
for use when composing a custom `boundaryOffset` on top of the default behaviour.

```ts
type DefaultBoundaryOffset = (root: HTMLElement) => { x: number; y: number };
```

### `Carousel.CSS_VARS`

A frozen object containing the names of all CSS custom properties used internally, useful for reading or setting them
without hardcoding strings.

```ts
Carousel.CSS_VARS.fadeSize; // "--carousel-fade-size"
Carousel.CSS_VARS.remainingForwards; // "--carousel-remaining-forwards"
Carousel.CSS_VARS.remainingBackwards; // "--carousel-remaining-backwards"
Carousel.CSS_VARS.fadeOffsetForwards; // "--carousel-fade-offset-forwards"
Carousel.CSS_VARS.fadeOffsetBackwards; // "--carousel-fade-offset-backwards"
Carousel.CSS_VARS.overscrollTranslateX; // "--carousel-overscroll-translate-x"
Carousel.CSS_VARS.scrollMarginInline; // "--carousel-scroll-margin-inline"
```
