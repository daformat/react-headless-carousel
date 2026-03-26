# React headless carousel

A react headless carousel component: scrollable, and swipeable carousel, even on desktop, complete with snapping,
friction, rubber-banding and overscroll.

<video width="320" height="240" controls>
  <source src="./public/carousel-overview-dark.mp4" type="video/mp4">
</video>

## Demo

https://hello-mat.com/design-engineering/component/carousel-component

## Component structure

```tsx
{/* Provides context to the carousel components */}
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
