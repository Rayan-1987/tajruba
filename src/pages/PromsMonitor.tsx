import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { api } from '../api';

interface Pathway {
  id: string;
  code: string;
  name_ar: string;
  timepoints: { id: string; code: string; name_ar: string; offset_days: number }[];
}

interface EpisodeScore {
  timepoint_code: string;
  timepoint_name: string;
  raw_score: number;
  band: string | null;
  baseline_score: number | null;
  delta: number | null;
  mcid_met: number | null;
}

interface Episode {
  id: string;
  patient_ref_hash: string;
  surgeon_ref: string | null;
  start_date: string;
  status: string;
  scores: EpisodeScore[];
}

interface Instrument {
  id: string;
  code: string;
  name_ar: string;
  license_status: 'free' | 'licensed_required';
  description_ar: string;
}

export default function PromsMonitor() {
  const [pathways, setPathways] = useState<Pathway[]>([]);
  const [pathwayId, setPathwayId] = useState('');
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [mcidSummary, setMcidSummary] = useState<{ timepoint: string; total: number; mcidMetPercent: number | null }[]>([]);
  const [instruments, setInstruments] = useState<Instrument[]>([]);

  useEffect(() => {
    api.get<{ pathways: Pathway[] }>('/proms/pathways').then((res) => {
      setPathways(res.pathways);
      if (res.pathways.length > 0) setPathwayId(res.pathways[0].id);
    });
    api.get<{ instruments: Instrument[] }>('/proms/instruments').then((res) => setInstruments(res.instruments));
  }, []);

  useEffect(() => {
    if (!pathwayId) return;
    api
      .get<{ episodes: Episode[]; mcidSummary: { timepoint: string; total: number; mcidMetPercent: number | null }[] }>(
        `/proms/outcomes?pathwayId=${pathwayId}`
      )
      .then((res) => {
        setEpisodes(res.episodes);
        setMcidSummary(res.mcidSummary);
      });
  }, [pathwayId]);

  const pathway = pathways.find((p) => p.id === pathwayId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">النتائج الصحية المبلغة من المريض (PROMs)</h2>
        <p className="text-sm text-slate-500">قياس طولي عبر مسار الرعاية، مع نسبة تجاوز الحد السريري MCID</p>
      </div>

      <select value={pathwayId} onChange={(e) => setPathwayId(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
        {pathways.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name_ar}
          </option>
        ))}
      </select>

      {mcidSummary.length > 0 && (
        <div className="rounded-2xl bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-700">% المرضى المتجاوزين للحد السريري MCID لكل نقطة قياس</h3>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={mcidSummary}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="timepoint" tick={{ fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Bar dataKey="mcidMetPercent" fill="#059669" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="overflow-x-auto rounded-2xl bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-slate-700">حالات المرضى - {pathway?.name_ar}</h3>
        <table className="w-full min-w-[600px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-right text-xs text-slate-400">
              <th className="pb-2">الجرّاح</th>
              <th className="pb-2">تاريخ البدء</th>
              {pathway?.timepoints.map((tp) => (
                <th key={tp.id} className="pb-2">
                  {tp.name_ar}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {episodes.map((ep) => (
              <tr key={ep.id} className="border-b border-slate-100">
                <td className="py-2 text-slate-600">{ep.surgeon_ref ?? '-'}</td>
                <td className="py-2 text-slate-500">{new Date(ep.start_date).toLocaleDateString('ar-SA')}</td>
                {pathway?.timepoints.map((tp) => {
                  const score = ep.scores.find((s) => s.timepoint_code === tp.code);
                  if (!score) return <td key={tp.id} className="py-2 text-slate-300">-</td>;
                  return (
                    <td key={tp.id} className="py-2">
                      <span className="font-semibold text-slate-700">{score.raw_score}</span>
                      {score.delta != null && (
                        <span className={`ms-1 text-xs ${score.mcid_met ? 'text-emerald-600' : 'text-slate-400'}`}>
                          (Δ{score.delta} {score.mcid_met ? '✓' : ''})
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {instruments.map((i) => (
          <div key={i.id} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="mb-1 flex items-center justify-between">
              <h4 className="font-semibold text-slate-800">{i.name_ar}</h4>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  i.license_status === 'free' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                }`}
              >
                {i.license_status === 'free' ? 'مجاني' : 'يتطلب ترخيص'}
              </span>
            </div>
            <p className="text-xs text-slate-500">{i.description_ar}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
