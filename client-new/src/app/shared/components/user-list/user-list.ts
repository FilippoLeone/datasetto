import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { UserGroup } from '../../../core/services/data.service';

@Component({
  selector: 'app-user-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './user-list.html',
  styleUrl: './user-list.scss'
})
export class UserListComponent {
  @Input() userGroups: UserGroup[] = [];

  getTotalUserCount(): number {
    return this.userGroups.reduce((total, group) => total + group.users.length, 0);
  }

  getStatusClass(status: string): string {
    return `status-${status}`;
  }
}
