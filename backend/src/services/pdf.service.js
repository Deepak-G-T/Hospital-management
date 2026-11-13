const PDFDocument = require('pdfkit');

const BLUE = '#1d4ed8';
const TEAL = '#0d9488';
const GRAY = '#475569';

function age(dob) {
  if (!dob) return '—';
  const d = new Date(dob); const now = new Date();
  let a = now.getFullYear() - d.getFullYear();
  if (now < new Date(now.getFullYear(), d.getMonth(), d.getDate())) a -= 1;
  return `${a} yrs`;
}

/** Streams a digital prescription as PDF to the given writable stream (e.g. Express res) */
function streamPrescriptionPdf(rx, stream) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Prescription ${rx.prescriptionNumber}` } });
  doc.pipe(stream);

  doc.rect(0, 0, doc.page.width, 90).fill(BLUE);
  doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold').text('MediCore Smart Hospital', 50, 28);
  doc.fontSize(10).font('Helvetica').text('Digital Prescription', 50, 56);
  doc.text(`No. ${rx.prescriptionNumber}`, 350, 32, { width: 195, align: 'right' });
  doc.text(new Date(rx.createdAt).toLocaleDateString('en-US', { dateStyle: 'long' }), 350, 48, { width: 195, align: 'right' });

  doc.fillColor('#0f172a').moveDown(4);
  const top = 115;
  doc.font('Helvetica-Bold').fontSize(11).fillColor(TEAL).text('DOCTOR', 50, top);
  doc.font('Helvetica').fillColor('#0f172a').fontSize(11)
    .text(`Dr. ${rx.doctor.fullName}`, 50, top + 16)
    .fillColor(GRAY).fontSize(9)
    .text(rx.doctor.specialization, 50, top + 31)
    .text(rx.doctor.qualification || '', 50, top + 43)
    .text(`License: ${rx.doctor.licenseNumber}`, 50, top + 55);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(TEAL).text('PATIENT', 320, top);
  doc.font('Helvetica').fillColor('#0f172a').fontSize(11)
    .text(rx.patient.fullName, 320, top + 16)
    .fillColor(GRAY).fontSize(9)
    .text(`Age: ${age(rx.patient.dateOfBirth)}   Gender: ${rx.patient.gender || '—'}`, 320, top + 31)
    .text(`Blood group: ${rx.patient.bloodGroup ? rx.patient.bloodGroup.replace('_POS', '+').replace('_NEG', '-') : '—'}`, 320, top + 43);

  const allergies = rx.patient.allergies || [];
  let y = top + 85;
  if (allergies.length) {
    doc.rect(50, y, 495, 22).fill('#fef2f2');
    doc.fillColor('#b91c1c').font('Helvetica-Bold').fontSize(9)
      .text(`ALLERGIES: ${allergies.map((a) => `${a.allergen} (${a.severity.toLowerCase()})`).join(', ')}`, 58, y + 7, { width: 480 });
    y += 34;
  }

  doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(11).text('DIAGNOSIS', 50, y);
  doc.fillColor('#0f172a').font('Helvetica').fontSize(10).text(rx.diagnosis, 50, y + 16, { width: 495 });
  y = doc.y + 18;

  doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(14).text('Rx', 50, y);
  y += 22;
  const cols = [50, 70, 230, 320, 410, 470];
  doc.rect(50, y, 495, 20).fill('#eff6ff');
  doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(9);
  ['#', 'Medicine', 'Dosage', 'Frequency', 'Days', 'Notes'].forEach((h, i) => doc.text(h, cols[i] + 4, y + 6));
  y += 24;
  doc.font('Helvetica').fillColor('#0f172a').fontSize(9);
  rx.items.forEach((item, idx) => {
    const rowTop = y;
    doc.text(String(idx + 1), cols[0] + 4, rowTop);
    doc.text(item.medicineName, cols[1] + 4, rowTop, { width: 150 });
    doc.text(item.dosage, cols[2] + 4, rowTop, { width: 85 });
    doc.text(item.frequency, cols[3] + 4, rowTop, { width: 85 });
    doc.text(String(item.durationDays), cols[4] + 4, rowTop, { width: 55 });
    doc.text(item.instructions || '—', cols[5] + 4, rowTop, { width: 72 });
    y = Math.max(doc.y, rowTop + 14) + 6;
    doc.moveTo(50, y - 3).lineTo(545, y - 3).strokeColor('#e2e8f0').stroke();
  });

  if (rx.advice) {
    y += 10;
    doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(11).text('ADVICE', 50, y);
    doc.fillColor('#0f172a').font('Helvetica').fontSize(10).text(rx.advice, 50, y + 16, { width: 495 });
    y = doc.y;
  }
  if (rx.followUpDate) {
    y += 12;
    doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(10)
      .text(`Follow-up on: ${new Date(rx.followUpDate).toLocaleDateString('en-US', { dateStyle: 'long' })}`, 50, y);
  }

  const footY = doc.page.height - 110;
  doc.moveTo(380, footY).lineTo(545, footY).strokeColor('#94a3b8').stroke();
  doc.fillColor(GRAY).fontSize(9).text(`Dr. ${rx.doctor.fullName}`, 380, footY + 6, { width: 165, align: 'center' });
  doc.text('Digitally issued', 380, footY + 18, { width: 165, align: 'center' });
  doc.fontSize(7.5).fillColor('#94a3b8').text(
    'This prescription was generated electronically by MediCore Smart Hospital. Verify the prescription number with the hospital if in doubt.',
    50, doc.page.height - 60, { width: 495, align: 'center' },
  );
  doc.end();
}

module.exports = { streamPrescriptionPdf };
