import { User } from "../../models/user.model";
import { Doctor } from "../../models/doctor.model";
import { Appointment } from "../../models/appointment.model";
import { AppointmentStatus, PaymentStatus, Role } from "../../types/enums";

// ===== System Stats =====

export async function getStats() {
  const [
    userStats,
    doctorStats,
    appointmentStats,
    revenueStats,
    revenueByMonth,
    newUsersThisMonth,
    topDoctors,
  ] = await Promise.all([
    // Users by role
    User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),

    // Doctors verified vs unverified
    Doctor.aggregate([{ $group: { _id: "$isVerified", count: { $sum: 1 } } }]),

    // Appointments by status
    Appointment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),

    // Total revenue — sum of paid appointments fees
    Appointment.aggregate([
      { $match: { paymentStatus: PaymentStatus.PAID } },
      {
        $lookup: {
          from: "doctors",
          localField: "doctorId",
          foreignField: "_id",
          as: "doctor",
        },
      },
      { $unwind: "$doctor" },
      {
        $group: {
          _id: null,
          // the amount actually charged; falls back to current fees for
          // appointments paid before amountCents was recorded
          total: {
            $sum: {
              $ifNull: [{ $divide: ["$amountCents", 100] }, "$doctor.fees"],
            },
          },
        },
      },
    ]),

    // Revenue by month — last 6 months
    Appointment.aggregate([
      {
        $match: {
          paymentStatus: PaymentStatus.PAID,
          confirmedAt: {
            $gte: new Date(new Date().setMonth(new Date().getMonth() - 6)),
          },
        },
      },
      {
        $lookup: {
          from: "doctors",
          localField: "doctorId",
          foreignField: "_id",
          as: "doctor",
        },
      },
      { $unwind: "$doctor" },
      {
        $group: {
          _id: {
            year: { $year: "$confirmedAt" },
            month: { $month: "$confirmedAt" },
          },
          revenue: {
            $sum: {
              $ifNull: [{ $divide: ["$amountCents", 100] }, "$doctor.fees"],
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]),

    // New users this month
    User.countDocuments({
      createdAt: {
        $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      },
    }),

    // Top 5 rated doctors
    Doctor.find({ isVerified: true })
      .sort({ averageRating: -1, totalReviews: -1 })
      .limit(5)
      .select("doctorName specialization averageRating totalReviews fees")
      .lean(),
  ]);

  // Format user stats
  const totalUsers = userStats.reduce((acc, cur) => acc + cur.count, 0);
  const usersByRole = Object.fromEntries(
    userStats.map((u: { _id: string; count: number }) => [u._id, u.count]),
  );

  // Format doctor stats
  const totalDoctors = doctorStats.reduce((acc, cur) => acc + cur.count, 0);
  const verifiedDoctors =
    doctorStats.find((d: { _id: boolean }) => d._id === true)?.count ?? 0;
  const unverifiedDoctors =
    doctorStats.find((d: { _id: boolean }) => d._id === false)?.count ?? 0;

  // Format appointment stats
  const totalAppointments = appointmentStats.reduce(
    (acc, cur) => acc + cur.count,
    0,
  );
  const appointmentsByStatus = Object.fromEntries(
    appointmentStats.map((a: { _id: string; count: number }) => [
      a._id,
      a.count,
    ]),
  );

  return {
    totalUsers,
    usersByRole,
    totalDoctors,
    doctors: { verified: verifiedDoctors, unverified: unverifiedDoctors },
    totalAppointments,
    appointmentsByStatus,
    totalRevenue: revenueStats[0]?.total ?? 0,
    revenueByMonth,
    newUsersThisMonth,
    topRatedDoctors: topDoctors,
  };
}

// ===== List Users =====

export async function listUsers(query: {
  role?: Role;
  page: number;
  limit: number;
}) {
  const { role, page, limit } = query;
  const skip = (page - 1) * limit;
  const filter: Record<string, unknown> = {};
  if (role) filter.role = role;

  const [users, total] = await Promise.all([
    User.find(filter)
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1, _id: -1 })
      .lean(),
    User.countDocuments(filter),
  ]);

  return {
    users,
    pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

// ===== Pending Doctors =====

export async function getPendingDoctors() {
  return Doctor.find({ isVerified: false })
    .populate("userId", "name email")
    .sort({ createdAt: -1 })
    .lean();
}
