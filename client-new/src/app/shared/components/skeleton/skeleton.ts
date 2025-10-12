import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-skeleton',
  imports: [CommonModule],
  templateUrl: './skeleton.html',
  styleUrl: './skeleton.css'
})
export class Skeleton {
  @Input() variant: 'text' | 'circular' | 'rectangular' = 'text';
  @Input() width?: string;
  @Input() height?: string;
  @Input() animation: 'pulse' | 'wave' | 'none' = 'pulse';
}
