/**
 * Customer identity store — resolve returning customers across platforms.
 *
 * In-memory for Phase 4. Production: persist to SQLCipher customers +
 * customer_identities tables from the architecture spec.
 */

import { randomUUID } from "node:crypto";

export interface Customer {
  id: string;
  name?: string;
  assignedEmployee?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  interactionCount: number;
}

export interface CustomerIdentity {
  platform: string;
  senderId: string;
  customerId: string;
}

export class CustomerStore {
  private customers = new Map<string, Customer>();
  private identities = new Map<string, string>(); // "platform:senderId" → customerId

  /**
   * Resolve a customer by platform + senderId.
   * Returns existing customer or creates a new one.
   */
  resolve(platform: string, senderId: string): Customer {
    const key = `${platform}:${senderId}`;
    const existingId = this.identities.get(key);

    if (existingId) {
      const customer = this.customers.get(existingId)!;
      customer.lastSeenAt = new Date().toISOString();
      customer.interactionCount++;
      return customer;
    }

    // New customer
    const customer: Customer = {
      id: randomUUID(),
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      interactionCount: 1,
    };
    this.customers.set(customer.id, customer);
    this.identities.set(key, customer.id);
    return customer;
  }

  /** Look up without creating */
  find(platform: string, senderId: string): Customer | undefined {
    const key = `${platform}:${senderId}`;
    const id = this.identities.get(key);
    return id ? this.customers.get(id) : undefined;
  }

  /** Set customer name */
  setName(customerId: string, name: string): void {
    const customer = this.customers.get(customerId);
    if (customer) customer.name = name;
  }

  /** Assign a customer to a specific employee */
  assignEmployee(customerId: string, employee: string): void {
    const customer = this.customers.get(customerId);
    if (customer) customer.assignedEmployee = employee;
  }

  /** Get customer count */
  count(): number {
    return this.customers.size;
  }

  /** Build greeting context for a returning customer */
  buildContext(customer: Customer): string | undefined {
    if (customer.interactionCount <= 1) return undefined;
    const parts = [`Returning customer (interaction #${customer.interactionCount})`];
    if (customer.name) parts.push(`Name: ${customer.name}`);
    if (customer.assignedEmployee) {
      parts.push(`Assigned to: ${customer.assignedEmployee}`);
    }
    return parts.join(". ");
  }
}
