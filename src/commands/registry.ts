import type { AnyCommand, CommandGroup } from './contract';

export class CommandRegistry {
  private readonly commands = new Map<string, AnyCommand>();

  register(...commands: AnyCommand[]): this {
    for (const command of commands) {
      if (this.commands.has(command.id)) throw new Error(`Command already registered: ${command.id}`);
      this.commands.set(command.id, command);
    }
    return this;
  }

  get(id: string): AnyCommand | undefined {
    return this.commands.get(id);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  all(): AnyCommand[] {
    return [...this.commands.values()];
  }

  byGroup(group: CommandGroup): AnyCommand[] {
    return this.all().filter((c) => c.group === group);
  }
}
