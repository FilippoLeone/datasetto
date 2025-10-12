import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Server } from '../../../core/services/data.service';

@Component({
  selector: 'app-servers-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './servers-list.html',
  styleUrl: './servers-list.scss'
})
export class ServersListComponent {
  @Input() servers: Server[] = [];
  @Input() activeServerId: string | null = null;
  @Output() serverSelected = new EventEmitter<string>();

  onServerClick(serverId: string): void {
    this.serverSelected.emit(serverId);
  }

  isActive(serverId: string): boolean {
    return this.activeServerId === serverId;
  }
}
