// Standalone interactive React chart server
const port = Number(Bun.env.PORT || 3333);

const server = Bun.serve({
  port,
  routes: {
    "/": Bun.file("public/chart.html"),
    "/chart": Bun.file("public/chart.html"),
    "/chart-data.json": Bun.file("public/chart-data.json"),
  },
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/chart-data.json") {
      return new Response(Bun.file("public/chart-data.json"), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n📊 Interactive React Strategy Chart ready at: http://localhost:${server.port}\n`);
