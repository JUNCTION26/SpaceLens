import { buildSafetyReport, reportHtml } from './report';
import type { SpaceModel } from '../../core/types';
import type { SafetyReport } from './assess';
import type { RulePack } from '../jurisdiction/rulepacks';
import './report.css';

interface Props { model: SpaceModel; assessment: SafetyReport; pack: RulePack }

export function ReportButton({ model, assessment, pack }: Props) {
  const open = () => {
    const html = reportHtml(buildSafetyReport(model, assessment, pack));
    const win = window.open('', '_blank');
    if (win) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      win.setTimeout(() => win.print(), 300);
      return;
    }
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(model.name || 'space').replace(/[^\w-]+/g, '_')}-safety-report.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <button type="button" className="report-btn" onClick={open} aria-label="Print safety report" title="Report">
      <span aria-hidden="true">&#128424;</span> Report
    </button>
  );
}
