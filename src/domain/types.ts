export interface Dealership {
  id: string;
  name: string;
  timezone: string;
  /** Local wall-clock opening time, 'HH:mm' or 'HH:mm:ss'. */
  opensAt: string;
  closesAt: string;
}

export interface ServiceType {
  id: string;
  code: string;
  name: string;
  durationMinutes: number;
  requiredSkill: string;
}

export interface Vehicle {
  id: string;
  customerId: string;
  vin: string;
  make: string;
  model: string;
  year: number;
}

export interface TechnicianCandidate {
  id: string;
  name: string;
  /** Minutes already booked for this technician on the appointment's local day. */
  bookedMinutes: number;
}

export interface BayCandidate {
  id: string;
  name: string;
}

export type AppointmentStatus = 'CONFIRMED' | 'CANCELLED';

export interface Appointment {
  id: string;
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  technicianId: string;
  serviceBayId: string;
  startTime: Date;
  endTime: Date;
  status: AppointmentStatus;
  notes: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface BookingRequest {
  dealershipId: string;
  customerId: string;
  vehicleId: string;
  serviceTypeId: string;
  startTime: string;
  notes?: string;
}
