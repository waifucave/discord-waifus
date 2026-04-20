import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodSchema } from "zod";

export function parseBody<T>(schema: ZodSchema<T>, request: Request): T {
  return schema.parse(request.body);
}

export function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response, next).catch(next);
  };
}

export function handleRouteError(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
): void {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Validation failed",
      issues: error.issues
    });
    return;
  }

  if (error instanceof Error) {
    response.status(500).json({
      error: error.message
    });
    return;
  }

  response.status(500).json({
    error: "Unknown error"
  });
}
