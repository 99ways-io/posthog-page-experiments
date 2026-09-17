const port = Number(process.env.PORT ?? 3000)

const server = Bun.serve({
  port,
  routes: {
    '/': new Response(Bun.file('demo/index.html'), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    '/dist/posthog-page-experiments.min.js': new Response(
      Bun.file('dist/posthog-page-experiments.min.js'),
      { headers: { 'Content-Type': 'text/javascript; charset=utf-8' } },
    ),
  },
  fetch() {
    return new Response('Not found', { status: 404 })
  },
})

console.log(`Demo: ${server.url}?demo-headline=test`)
