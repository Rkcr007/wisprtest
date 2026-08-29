import type { ScreenNode } from 'protocol';

import { formatRate, formatUtc } from '../format';
import type { AliasList, ElementList, GraphList, ScreenList } from '../memory/schema';

/**
 * Product Memory: screens, the navigation graph, elements, aliases.
 *
 * Choosing a screen is a query-string navigation so the first paint is still a Server Component
 * fetch. The graph is the same edges the snapshot holds — clicking a node scopes the table.
 */
export function MemoryExplorer({
  applicationId,
  screens,
  elements,
  graph,
  aliases,
  selectedScreenId,
}: {
  readonly applicationId: string;
  readonly screens: ScreenList;
  readonly elements: ElementList;
  readonly graph: GraphList;
  readonly aliases: AliasList;
  readonly selectedScreenId: string | null;
}) {
  const selected = screens.screens.find((screen) => screen.id === selectedScreenId) ?? null;
  const href = (screenId: string | null): string => {
    const base = `/applications/${applicationId}/memory`;
    return screenId === null ? base : `${base}?screenId=${screenId}`;
  };

  return (
    <>
      <section className="card" aria-labelledby="memory-screens">
        <h2 id="memory-screens">Screens</h2>
        <p className="hint">
          {screens.memoryVersionId === null
            ? 'No active memory version. Index this application first.'
            : `${String(screens.total)} reachable states in the active version.`}
        </p>
        {screens.screens.length === 0 ? null : (
          <div className="scroll">
            <table>
              <caption>Indexed screens. Selecting one scopes the element table.</caption>
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Route</th>
                  <th scope="col">Indexed</th>
                </tr>
              </thead>
              <tbody>
                {screens.screens.map((screen) => (
                  <ScreenRow
                    key={screen.id}
                    screen={screen}
                    href={href(screen.id)}
                    current={selected?.id === screen.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selected === null ? null : (
          <p>
            Showing elements on {selected.label}. <a href={href(null)}>Show all</a>
          </p>
        )}
      </section>

      <section className="card" aria-labelledby="memory-graph">
        <h2 id="memory-graph">Navigation graph</h2>
        {graph.edges.length === 0 ? (
          <p className="hint">No transitions were observed during indexing.</p>
        ) : (
          <ul className="diff-list">
            {graph.edges.map((edge) => (
              <li key={edge.id}>
                <a href={href(edge.fromScreenId)}>{labelOf(screens.screens, edge.fromScreenId)}</a>
                {' → '}
                <a href={href(edge.toScreenId)}>{labelOf(screens.screens, edge.toScreenId)}</a>
                <span className="hint"> · {formatRate(edge.confidence)} observed</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="memory-elements">
        <h2 id="memory-elements">Elements</h2>
        <div className="scroll">
          <table>
            <caption>
              {selected === null
                ? `${String(elements.total)} elements in the active version.`
                : `${String(elements.total)} elements on ${selected.label}.`}
            </caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">Role</th>
                <th scope="col" className="numeric">
                  Confidence
                </th>
                <th scope="col" className="numeric">
                  Stability
                </th>
              </tr>
            </thead>
            <tbody>
              {elements.elements.length === 0 ? (
                <tr>
                  <td colSpan={4} className="hint">
                    No elements in this scope.
                  </td>
                </tr>
              ) : (
                elements.elements.map((element) => (
                  <tr key={element.id}>
                    <td className="path">{element.elementKey}</td>
                    <td>{element.fingerprint.role}</td>
                    <td className="numeric">{formatRate(element.confidence)}</td>
                    <td className="numeric">{formatRate(element.stability)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" aria-labelledby="memory-aliases">
        <h2 id="memory-aliases">Vocabulary</h2>
        <p className="hint">
          Phrases are listed with their source and hit count. Teaching a new phrase happens at T2
          write-back, not here — a console CRUD surface would skip the compounding loop.
        </p>
        <div className="scroll">
          <table>
            <caption>{String(aliases.total)} aliases in the active version.</caption>
            <thead>
              <tr>
                <th scope="col">Phrase</th>
                <th scope="col">Source</th>
                <th scope="col" className="numeric">
                  Hits
                </th>
              </tr>
            </thead>
            <tbody>
              {aliases.aliases.length === 0 ? (
                <tr>
                  <td colSpan={3} className="hint">
                    No aliases yet.
                  </td>
                </tr>
              ) : (
                aliases.aliases.map((alias) => (
                  <tr key={alias.id}>
                    <td>{alias.phrase}</td>
                    <td>{alias.source}</td>
                    <td className="numeric">{alias.hits}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ScreenRow({
  screen,
  href,
  current,
}: {
  readonly screen: ScreenNode;
  readonly href: string;
  readonly current: boolean;
}) {
  return (
    <tr>
      <td>
        <a href={href} aria-current={current ? 'page' : undefined}>
          {screen.label}
        </a>
      </td>
      <td className="path">{screen.routePattern}</td>
      <td>{formatUtc(screen.indexedAt)}</td>
    </tr>
  );
}

function labelOf(screens: readonly ScreenNode[], id: string): string {
  return screens.find((screen) => screen.id === id)?.label ?? id;
}
