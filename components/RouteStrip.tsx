import { ROUTE_STEPS, routePosition, statusLabel, EXCEPTION_STATES } from "@/lib/ride-display";

/**
 * The ride lifecycle drawn as a transit line. This is the one loud element in
 * the interface; everything around it stays quiet.
 */
export function RouteStrip({ status }: { status: string }) {
  const exception = EXCEPTION_STATES[status];
  const position = routePosition(status);

  return (
    <div className="route">
      <ol aria-hidden="true">
        {ROUTE_STEPS.map((step, i) => (
          <li
            key={step.state}
            data-done={!exception && i < position ? "true" : "false"}
            data-current={!exception && i === position ? "true" : "false"}
          />
        ))}
      </ol>
      <p className="route-label" role="status">
        {statusLabel(status)}
      </p>
      {!exception && position >= 0 && (
        <p className="route-sub">
          Step {position + 1} of {ROUTE_STEPS.length}
        </p>
      )}
    </div>
  );
}
