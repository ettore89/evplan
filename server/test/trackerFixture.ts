/** Synthetic OM Ramp-Up Tracker workbook (fictional names) for import tests. */
import ExcelJS from 'exceljs';

const GREEN = 'FF92D050';
const YELLOW = 'FFFFFF00';
const RED = 'FFFF0000';
const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } });

export async function trackerWorkbook(opts: { modified?: Date; extraUnit?: boolean; renamed?: boolean } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.modified = opts.modified ?? new Date('2026-11-02T10:00:00Z');

  const pr = wb.addWorksheet('Priority for 2026 and QTY');
  pr.getRow(2).values = ['', 'Prio', 'EAP', 'Series', 'Customer', 'Rational', 'scope', 'Required Commissioning', 'Required EXW', 'Customer situation', 'SO Number in SAP', 'O2C Responsible',
    'Mitigations', 'Cabinet Name', 'Cabinet code', 'cabinet count', 'Dispenser A Name', 'Dispenser A Code', 'Right code', 'Dispenser A count', 'Dispenser B Name', 'Dispenser B Code', 'Dispenser B count'];
  pr.getRow(3).values = ['', 1, 'W1', 'X', opts.renamed ? 'Nordwind Energie Berlin - (500123, Nordwind AG)' : 'Nordwind Energie Berlin', 'Flagship', '1*X800, 2*SOLO', '20.01.2027', '18.12.2026', 'stable', '100099001', 'A. Example', '', 'EAP CE OM800', 'YAD.B1320', 1,
    'OM SOLO', 'YAD.A0H14.0', '', 2];
  pr.getRow(4).values = ['', 2, 'W2', 'M', opts.renamed ? 'Fjord Transit Oslo' : 'Fjord Transit Oslo Pilot', 'Pilot', 'M400-2-DOCK-2', 'Q1 2027', 'end of January', 'PO pending', '', '', '', 'EAP M400 CE', 'YAE.A0L05.0', 1,
    'Dock', 'YAE.A0Q05.0', '', 2];
  pr.getRow(5).values = ['', 3, 'W2', 'X', 'Nordwind Energie Hamburg', 'Second site', '1*X800, 2*SOLO', 'March 2027', '', 'stable', '100099002', '', '', 'EAP CE OM800', 'YAD.B1320', 1,
    'OM SOLO', 'YAD.A0H14.0', '', 2];

  const pp = wb.addWorksheet('Production Plan');
  pp.getCell('A1').value = 'Work in process'; pp.getCell('A1').fill = fill(YELLOW);
  pp.getCell('A2').value = 'Completed'; pp.getCell('A2').fill = fill(GREEN);
  pp.getCell('A3').value = 'Delay \\ Critical'; pp.getCell('A3').fill = fill(RED);
  const start = new Date(Date.UTC(2026, 9, 26));
  for (let i = 0; i < 28; i++) pp.getCell(3, 30 + i).value = new Date(start.getTime() + i * 86400000);
  pp.getRow(4).values = ['Name', 'Mapping to Pre MG5 S&OP file', '', 'Item Code', 'Serial', 'Maturity level', '', 'Installation date', 'Requested EXW', 'Production END', 'Confirmed \nEXW date', '',
    'Component\nAvailability', 'Sub assembly readiness'];
  pp.getCell(4, 28).value = 'EOL status';
  const unit = (r: number, name: string, mapping: string, item: string, serial: string | null, opts2: { done?: boolean; eolDay?: number; subs?: [string, string][]; comp?: string; exw?: Date }) => {
    pp.getCell(r, 1).value = name; pp.getCell(r, 2).value = mapping; pp.getCell(r, 4).value = item; if (serial) pp.getCell(r, 5).value = serial;
    pp.getCell(r, 6).value = 'SILVER';
    if (opts2.exw) pp.getCell(r, 11).value = opts2.exw;
    if (opts2.comp) pp.getCell(r, 13).value = opts2.comp;
    (opts2.subs ?? []).forEach(([n, f], i) => { pp.getCell(r, 14 + i).value = n; if (f) pp.getCell(r, 14 + i).fill = fill(f); });
    if (opts2.done) { pp.getCell(r, 1).fill = fill(GREEN); pp.getCell(r, 28).value = 'Completed (no charge session)'; }
    if (opts2.eolDay !== undefined) { pp.getCell(r, 30 + opts2.eolDay - 1).value = 'P'; pp.getCell(r, 30 + opts2.eolDay).value = 'EOL'; }
  };
  unit(5, 'Cabinet NW1', 'X-System 1 Nordwind', 'YAD.B1320', 'X08-T-0001', { done: true, eolDay: 2, exw: new Date(Date.UTC(2026, 11, 18)) });
  unit(6, 'Pollux NW.1', 'X-System 1 Nordwind (Pollux 1)', 'YAD.A0H14.0', 'SOLO-T-0001', { done: true, eolDay: 3 });
  unit(7, 'Pollux NW.2', 'X-System 1 Nordwind (Pollux 2)', 'YAD.A0H14.0', 'SOLO-T-0002', { subs: [['AC Box', GREEN], ['DC Box', YELLOW], ['Cooler', '']], comp: 'Missing cooler fan' });
  unit(8, 'M400 - Fjord1', 'EAP - Fjord Transit', 'YAE.A0L05.0', null, {});
  unit(9, 'CD02 - Fjord1', 'EAP - Fjord Transit', 'YAE.A0Q05.0', null, {});
  unit(10, 'Pollux R&D 9', 'Only Pollux R&D (thermal)', 'YAD.A0H05.1', 'SOLO-T-0099', { done: true });
  unit(11, '5 AC Steel (spare)', 'Mid urgency', '5', null, {});
  if (opts.extraUnit) unit(12, 'Pollux NW.3', 'X-System 1 Nordwind (Pollux 3)', 'YAD.A0H14.0', 'SOLO-T-0003', {});

  const os = wb.addWorksheet('On Site Plan');
  os.getRow(9).values = ['Project Name', 'Role', 'Person', 'System Configuration', '', 'Planning status of Person', '', 'Confirmed  / EXW date', 'Arrival on Site Base Plate', 'Arrival on Site Charger ',
    'Start of Installation', 'End of Installation', 'Start of Commis-sioning', 'End of Commis-sioning', 'Start of Operation'];
  os.getRow(10).values = ['NW Berlin Westhafen', '', '', 'X800-2-SOLO-2', '', 'confirmed', '', new Date(Date.UTC(2026, 11, 18)), null, new Date(Date.UTC(2027, 0, 5)), new Date(Date.UTC(2027, 0, 6)),
    new Date(Date.UTC(2027, 0, 12)), new Date(Date.UTC(2027, 0, 13)), new Date(Date.UTC(2027, 0, 15))];
  os.getRow(11).values = ['', 'Project Manager', 'P. Example'];
  os.getRow(12).values = ['', 'Commissioning Engineer', 'Q. Example'];

  const sw = wb.addWorksheet('EAP SW Versions');
  sw.getRow(1).values = ['EAP Release', 'Known Issues'];
  sw.getRow(2).values = ['Release 9.9.1.1'];
  sw.getRow(3).values = ['', 'Example known issue'];

  const tr = wb.addWorksheet('Tracker');
  tr.getRow(2).values = ['Topic', 'Actions', 'Responsible', 'Status', 'Next Follow-up'];
  tr.getRow(3).values = ['Cooler fan supply', '02.11.2026: supplier confirms W47', 'Buyer X', 'Ongoing', '09.11.2026'];
  tr.getRow(4).values = ['Old topic', 'done', 'Someone', 'Closed', ''];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
