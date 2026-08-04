export type AppView =
  | 'home'
  | 'create'
  | 'jobs'
  | 'lessons'
  | 'my-lessons'
  | 'lesson-view'
  | 'admin'
  | 'review'
  | 'profile'
  | 'login';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type PublishStatus = 'draft' | 'pending' | 'approved' | 'rejected';
export type UserRole = 'student' | 'teacher' | 'admin';

export interface User {
  id: string;
  email: string;
  nickname: string;
  role: UserRole;
  status?: string;
}

export interface ProblemType {
  key: string;
  name: string;
  params: { key: string; name: string; type: string; default?: number }[];
}

export interface Skill {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  renderEngine: string;
  problemTypes: ProblemType[];
}

export interface CatalogResponse {
  skills: Skill[];
  installed: boolean;
}

export interface GenerationJob {
  id: string;
  status: JobStatus;
  progress: number;
  currentStage: string;
  skillId: string;
  problemType: string;
  params: Record<string, unknown>;
  title: string;
  errorMessage?: string;
  resultLessonId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Lesson {
  id: string;
  userId: string;
  jobId?: string | null;
  skillId: string;
  problemType: string;
  title: string;
  summary: string;
  htmlPath?: string;
  fileSize: number;
  publishStatus: PublishStatus;
  visibility: 'private' | 'public';
  viewCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminStats {
  users: number;
  jobs: number;
  runningJobs: number;
  lessons: number;
  pendingReviews: number;
}
