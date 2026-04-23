/**
 * Gateway router — routes normalized messages to employees based on config.
 *
 * Routing strategy (ordered by specificity):
 * 1. Route config match (platform + channel + sender rules, first match wins)
 * 2. Default route (fallback)
 *
 * Customer identity routing is deferred to Phase 2.
 */

import type {
  NormalizedMessage,
  GatewayConfig,
  RouteMatch,
  AdapterPermissions,
  GatewayPlatform,
} from "./types.js";

export interface RouteResult {
  employee: string;
  modelTier: "haiku" | "sonnet" | "opus";
  permissions: AdapterPermissions;
  routeName: string;
}

function matchesPlatform(
  msgPlatform: GatewayPlatform,
  matchPlatform: GatewayPlatform | GatewayPlatform[] | undefined,
): boolean {
  if (!matchPlatform) return true;
  const platforms = Array.isArray(matchPlatform)
    ? matchPlatform
    : [matchPlatform];
  return platforms.includes(msgPlatform);
}

function matchesChannel(
  msgChannel: string,
  matchChannel: string | string[] | undefined,
): boolean {
  if (!matchChannel) return true;
  const channels = Array.isArray(matchChannel)
    ? matchChannel
    : [matchChannel];
  return channels.includes(msgChannel);
}

function matchesSender(
  msgSender: string,
  matchSender: string | undefined,
): boolean {
  if (!matchSender) return true;
  return new RegExp(matchSender).test(msgSender);
}

function matchesTextPattern(
  msgText: string,
  matchPattern: string | undefined,
): boolean {
  if (!matchPattern) return true;
  return new RegExp(matchPattern, "i").test(msgText);
}

function matchesRoute(msg: NormalizedMessage, match: RouteMatch): boolean {
  return (
    matchesPlatform(msg.platform, match.platform) &&
    matchesChannel(msg.channelId, match.channelId) &&
    matchesSender(msg.senderId, match.senderId) &&
    matchesTextPattern(msg.text, match.textPattern)
  );
}

/**
 * Route a normalized message to the appropriate employee.
 * First matching route wins. Falls back to default route.
 */
export function routeMessage(
  msg: NormalizedMessage,
  config: GatewayConfig,
): RouteResult {
  for (const route of config.routes) {
    if (matchesRoute(msg, route.match)) {
      return {
        employee: route.target,
        modelTier: route.modelTier,
        permissions: route.permissions,
        routeName: route.name,
      };
    }
  }

  return {
    employee: config.defaultRoute,
    modelTier: config.defaultModelTier,
    permissions: config.defaultPermissions,
    routeName: "default",
  };
}

/**
 * Validate a gateway config for common mistakes.
 * Returns list of warnings (empty = valid).
 */
export function validateGatewayConfig(config: GatewayConfig): string[] {
  const warnings: string[] = [];

  if (!config.routes.length) {
    warnings.push("No routes configured — all messages will use default route");
  }

  if (!config.defaultRoute) {
    warnings.push("No default route specified");
  }

  const names = new Set<string>();
  for (const route of config.routes) {
    if (names.has(route.name)) {
      warnings.push(`Duplicate route name: "${route.name}"`);
    }
    names.add(route.name);

    if (!route.target) {
      warnings.push(`Route "${route.name}" has no target employee`);
    }

    // Empty match = catches everything, warn if not last
    const isEmptyMatch =
      !route.match.platform &&
      !route.match.channelId &&
      !route.match.senderId &&
      !route.match.textPattern;
    if (isEmptyMatch && config.routes.indexOf(route) !== config.routes.length - 1) {
      warnings.push(
        `Route "${route.name}" matches everything but is not the last route — routes after it will never match`,
      );
    }
  }

  return warnings;
}
