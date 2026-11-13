// Shared Prisma relation selections, so the same "shape" of a related record isn't rewritten in every file.
// Use as a relation value, e.g. include: { doctor: doctorBrief, department: departmentRef }.
// Frozen so a caller can't accidentally change them for everyone else.
const freeze = (o) => Object.freeze(o);

module.exports = {
  /** { fullName } — a doctor/patient name for lists and messages */
  nameOnly: freeze({ select: { fullName: true } }),
  /** { id, fullName } */
  idAndName: freeze({ select: { id: true, fullName: true } }),
  /** { id, fullName, specialization } — a doctor card line */
  doctorBrief: freeze({ select: { id: true, fullName: true, specialization: true } }),
  /** { fullName, specialization } */
  doctorNameAndSpecialty: freeze({ select: { fullName: true, specialization: true } }),
  /** { id, name } */
  departmentRef: freeze({ select: { id: true, name: true } }),
  /** { name } */
  departmentName: freeze({ select: { name: true } }),
  /** { email } */
  userEmail: freeze({ select: { email: true } }),
  /** { userId } — to notify a doctor/patient */
  userIdOnly: freeze({ select: { userId: true } }),
  /** who created a medical record: { role, doctor: { fullName } } */
  recordAuthor: freeze({ select: { role: true, doctor: { select: { fullName: true } } } }),
};
