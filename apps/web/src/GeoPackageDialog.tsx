import { useEffect, useMemo, useRef, useState } from 'react';
import type { DisplayRow } from '@zoning/core';
import { cancelExport, exportFileUrl, getExport, planExport, startExport, type ExportStatus, type PlannedMap } from './api';

/** The link to download: the service the check resolved to (for viewer links), otherwise the sheet's own link. */
const linkOf = (d: DisplayRow) => d.result?.normalizedUrl || d.row.url;
const itemOf = (d: DisplayRow) => ({ rowId: d.row.id, city: d.row.city, state: d.row.state, url: linkOf(d) });

const GEOMETRY_WORD: Record<string, string> = { esriGeometryPolygon: 'polygons', esriGeometryPolyline: 'lines', esriGeometryPoint: 'points', esriGeometryMultipoint: 'points' };

const fmtBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

type Phase = 'planning' | 'choose' | 'running' | 'finished';

export function GeoPackageDialog(props: { rows: DisplayRow[]; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [phase, setPhase] = useState<Phase>('planning');
  const [maps, setMaps] = useState<PlannedMap[]>([]);
  const [chosen, setChosen] = useState<Record<string, Set<number>>>({});
  const [error, setError] = useState('');
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const jobId = useRef<string | null>(null);
  const downloaded = useRef(false);

  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);

  // Which layers does each map have?
  useEffect(() => {
    let live = true;
    planExport(props.rows.map(itemOf))
      .then((r) => {
        if (!live) return;
        setMaps(r.maps);
        setChosen(Object.fromEntries(r.maps.map((m, i) => [String(i), new Set(m.layers.filter((l) => l.selected).map((l) => l.id))])));
        setPhase('choose');
      })
      .catch((e) => live && (setError(e instanceof Error ? e.message : String(e)), setPhase('choose')));
    return () => {
      live = false;
    };
  }, [props.rows]);

  // Cancel a download that is still running when the dialog is closed.
  useEffect(() => () => {
    const id = jobId.current;
    if (id && !downloaded.current) cancelExport(id).catch(() => undefined);
  }, []);

  const total = useMemo(() => Object.values(chosen).reduce((n, s) => n + s.size, 0), [chosen]);

  const toggle = (mi: number, layer: number) =>
    setChosen((c) => {
      const next = new Set(c[mi] ?? []);
      next.has(layer) ? next.delete(layer) : next.add(layer);
      return { ...c, [mi]: next };
    });

  const start = async () => {
    setError('');
    try {
      const items = maps.flatMap((m, i) => {
        const ids = [...(chosen[String(i)] ?? [])];
        return ids.length ? [{ rowId: m.rowId, city: m.city, state: m.state, url: m.url, layerIds: ids }] : [];
      });
      const { id } = await startExport(items);
      jobId.current = id;
      setPhase('running');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Poll the job; when it is done the browser downloads the file by itself.
  useEffect(() => {
    if (phase !== 'running' || !jobId.current) return;
    const id = jobId.current;
    let live = true;
    const tick = async () => {
      try {
        const s = await getExport(id);
        if (!live) return;
        setStatus(s);
        if (s.state === 'running') return void setTimeout(tick, 600);
        setPhase('finished');
        if (s.state === 'done' && !downloaded.current) {
          downloaded.current = true;
          const a = document.createElement('a');
          a.href = exportFileUrl(id);
          a.download = s.filename;
          a.click();
        }
      } catch (e) {
        if (live) (setError(e instanceof Error ? e.message : String(e)), setPhase('finished'));
      }
    };
    tick();
    return () => {
      live = false;
    };
  }, [phase]);

  const pct = status && status.progress.layersTotal ? Math.min(100, Math.round(((status.progress.layersDone + (status.progress.layerTotal ? status.progress.layerFeatures / status.progress.layerTotal : 0)) / status.progress.layersTotal) * 100)) : 0;

  return (
    <dialog ref={ref} className="dialog wide gpkg" onClose={props.onClose} aria-labelledby="gp-title">
      <h2 id="gp-title">Download as GeoPackage</h2>
      <p className="muted small">One <code>.gpkg</code> file (opens in QGIS, ArcGIS Pro and other GIS software). Every layer becomes one table, in WGS 84 (EPSG:4326), with its attributes.</p>

      {phase === 'planning' && <p className="muted">Looking up the layers of {props.rows.length} map{props.rows.length === 1 ? '' : 's'}…</p>}
      {error && <p className="bad" role="alert">{error}</p>}

      {phase === 'choose' && (
        <>
          <div className="gpkg-maps">
            {maps.map((m, mi) => (
              <section key={mi} className="gpkg-map">
                <h3>{m.city}{m.state ? `, ${m.state}` : ''}</h3>
                {m.error ? (
                  <p className="muted small">{m.error}</p>
                ) : (
                  <ul className="plain">
                    {m.layers.map((l) => (
                      <li key={l.id}>
                        <label className={l.exportable ? '' : 'disabled'}>
                          <input type="checkbox" disabled={!l.exportable} checked={chosen[String(mi)]?.has(l.id) ?? false} onChange={() => toggle(mi, l.id)} />
                          <span>{l.name}</span>
                          <small className="muted">{l.exportable ? (GEOMETRY_WORD[l.geometryType ?? ''] ?? 'features') : l.note}{l.zoning && l.exportable ? ' · zoning' : ''}</small>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
          <p className="muted small">Large layers can take a few minutes. Layers that cannot be downloaded (tables, secured or query-disabled layers) are skipped and listed afterwards.</p>
        </>
      )}

      {(phase === 'running' || phase === 'finished') && status && (
        <>
          <div className="gpkg-progress" role="progressbar" aria-valuenow={status.state === 'done' ? 100 : pct} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${status.state === 'done' ? 100 : pct}%` }} />
          </div>
          <p className="small">
            {status.state === 'running' && <>Downloading <strong>{status.progress.current}</strong> · {status.progress.layersDone}/{status.progress.layersTotal} layers · {status.progress.features.toLocaleString()} features{status.progress.layerTotal ? ` (this layer ${status.progress.layerFeatures.toLocaleString()} of ${status.progress.layerTotal.toLocaleString()})` : ''}</>}
            {status.state === 'done' && <span className="ok-text">Done · {status.progress.features.toLocaleString()} features · {fmtBytes(status.bytes)} · <a href={exportFileUrl(status.id)} download={status.filename}>Download again</a></span>}
            {status.state === 'error' && <span className="bad">Nothing could be downloaded: {status.error}</span>}
            {status.state === 'cancelled' && <span className="warn-text">Cancelled.</span>}
          </p>
          {status.layers.length > 0 && (
            <table className="mini gpkg-report">
              <thead><tr><th>Map</th><th>Layer</th><th>Features</th><th>Result</th></tr></thead>
              <tbody>
                {status.layers.map((l, i) => (
                  <tr key={i}>
                    <td>{l.map}</td>
                    <td>{l.layer}</td>
                    <td>{l.table ? l.features.toLocaleString() : '–'}</td>
                    <td className={l.error ? 'bad' : l.truncated || l.skipped ? 'warn-text' : 'ok-text'}>
                      {l.error ? l.error : `saved${l.truncated ? ' · stopped at the 300,000 feature limit' : ''}${l.skipped ? ` · ${l.skipped} without usable geometry left out` : ''}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      <div className="dialog-actions">
        {phase === 'running' && <button onClick={() => jobId.current && cancelExport(jobId.current)}>Cancel download</button>}
        {phase === 'choose' && <button className="primary" disabled={total === 0} onClick={start}>Create GeoPackage ({total} layer{total === 1 ? '' : 's'})</button>}
        <button onClick={() => ref.current?.close()}>{phase === 'finished' ? 'Close' : 'Cancel'}</button>
      </div>
    </dialog>
  );
}
