/**
 * Customer identity store — resolve returning customers across platforms.
 *
 * Prisma-backed for production. Persists customer identity across restarts and
 * supports cross-platform identity merge (same person on WhatsApp + Telegram → one customer).
 */

import { randomUUID } from "node:crypto";
import { isInitialized, getPrisma } from "./db.js";

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
  private memCustomers = new Map<string, Customer>();
  private memIdentities = new Map<string, string>();

  resolve(platform: string, senderId: string): Customer {
    if (isInitialized()) {
      this.resolveDB(platform, senderId).catch((err) => {
        console.error("[customer-store] DB resolve error:", err instanceof Error ? err.message : err);
      });
    }
    return this.resolveInMemory(platform, senderId);
  }

  async resolveAsync(platform: string, senderId: string): Promise<Customer> {
    if (isInitialized()) {
      return this.resolveDB(platform, senderId);
    }
    return this.resolveInMemory(platform, senderId);
  }

  find(platform: string, senderId: string): Customer | undefined {
    const key = `${platform}:${senderId}`;
    const id = this.memIdentities.get(key);
    return id ? this.memCustomers.get(id) : undefined;
  }

  async findAsync(platform: string, senderId: string): Promise<Customer | undefined> {
    if (!isInitialized()) return this.find(platform, senderId);

    try {
      const prisma = await getPrisma();
      const identity = await prisma.gatewayCustomerIdentity.findFirst({
        where: { platform, senderId },
        include: { customer: true },
      });

      if (!identity?.customer) return undefined;
      return mapCustomer(identity.customer);
    } catch {
      return this.find(platform, senderId);
    }
  }

  async setName(customerId: string, name: string): Promise<void> {
    const customer = this.memCustomers.get(customerId);
    if (customer) customer.name = name;

    if (isInitialized()) {
      try {
        const prisma = await getPrisma();
        await prisma.gatewayCustomer.update({
          where: { id: customerId },
          data: { name },
        });
      } catch (err) {
        console.error("[customer-store] setName DB error:", err instanceof Error ? err.message : err);
      }
    }
  }

  async assignEmployee(customerId: string, employee: string): Promise<void> {
    const customer = this.memCustomers.get(customerId);
    if (customer) customer.assignedEmployee = employee;

    if (isInitialized()) {
      try {
        const prisma = await getPrisma();
        await prisma.gatewayCustomer.update({
          where: { id: customerId },
          data: { assignedEmployee: employee },
        });
      } catch (err) {
        console.error("[customer-store] assignEmployee DB error:", err instanceof Error ? err.message : err);
      }
    }
  }

  count(): number {
    return this.memCustomers.size;
  }

  async getIdentities(customerId: string): Promise<CustomerIdentity[]> {
    if (!isInitialized()) return [];

    try {
      const prisma = await getPrisma();
      const identities = await prisma.gatewayCustomerIdentity.findMany({
        where: { customerId },
      });
      return identities.map((identity) => ({
        platform: identity.platform,
        senderId: identity.senderId,
        customerId: identity.customerId,
      }));
    } catch {
      return [];
    }
  }

  buildContext(customer: Customer): string | undefined {
    if (customer.interactionCount <= 1) return undefined;
    const parts = [`Returning customer (interaction #${customer.interactionCount})`];
    if (customer.name) parts.push(`Name: ${customer.name}`);
    if (customer.assignedEmployee) {
      parts.push(`Assigned to: ${customer.assignedEmployee}`);
    }
    return parts.join(". ");
  }

  private resolveInMemory(platform: string, senderId: string): Customer {
    const key = `${platform}:${senderId}`;
    const existingId = this.memIdentities.get(key);

    if (existingId) {
      const customer = this.memCustomers.get(existingId)!;
      customer.lastSeenAt = new Date().toISOString();
      customer.interactionCount++;
      return customer;
    }

    const customer: Customer = {
      id: randomUUID(),
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      interactionCount: 1,
    };
    this.memCustomers.set(customer.id, customer);
    this.memIdentities.set(key, customer.id);
    return customer;
  }

  private async resolveDB(platform: string, senderId: string): Promise<Customer> {
    const prisma = await getPrisma();

    const existingIdentity = await prisma.gatewayCustomerIdentity.findFirst({
      where: { platform, senderId },
      include: { customer: true },
    });

    if (existingIdentity?.customer) {
      const updated = await prisma.gatewayCustomer.update({
        where: { id: existingIdentity.customer.id },
        data: {
          lastSeenAt: new Date(),
          interactionCount: { increment: 1 },
        },
      });

      const customer = mapCustomer(updated);
      this.memCustomers.set(customer.id, customer);
      this.memIdentities.set(`${platform}:${senderId}`, customer.id);
      return customer;
    }

    const id = randomUUID();
    const now = new Date();

    await prisma.$transaction?.(async (tx) => {
      await tx.gatewayCustomer.create({
        data: {
          id,
          firstSeenAt: now,
          lastSeenAt: now,
          interactionCount: 1,
        },
      });
      await tx.gatewayCustomerIdentity.create({
        data: {
          customerId: id,
          platform,
          senderId,
        },
      });
    }) ?? (async () => {
      await prisma.gatewayCustomer.create({
        data: {
          id,
          firstSeenAt: now,
          lastSeenAt: now,
          interactionCount: 1,
        },
      });
      await prisma.gatewayCustomerIdentity.create({
        data: {
          customerId: id,
          platform,
          senderId,
        },
      });
    })();

    const customer: Customer = {
      id,
      firstSeenAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      interactionCount: 1,
    };

    this.memCustomers.set(id, customer);
    this.memIdentities.set(`${platform}:${senderId}`, id);
    return customer;
  }
}

function mapCustomer(record: any): Customer {
  return {
    id: record.id,
    name: record.name ?? undefined,
    assignedEmployee: record.assignedEmployee ?? undefined,
    firstSeenAt: record.firstSeenAt.toISOString(),
    lastSeenAt: record.lastSeenAt.toISOString(),
    interactionCount: record.interactionCount,
  };
}
