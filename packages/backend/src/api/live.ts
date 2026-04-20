import type { Express } from "express";

export function setupLiveRoutes(app: Express): void {
  app.get("/api/live/:channelId", (request, response) => {
    response.json({
      channelId: request.params.channelId,
      transport: "socket.io",
      subscribeEvent: "subscribe",
      unsubscribeEvent: "unsubscribe"
    });
  });
}
