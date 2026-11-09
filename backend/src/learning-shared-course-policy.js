import {isCatalogAdmin} from './learning-catalog-archive.js';
import {FormAuthoringError} from './learning-form-authoring.js';

export const sharedCourseCodes = ['34','45','56','67'];

export async function sharedCourseCapabilities(db,email) {
  const {rows}=await db.query(`SELECT c.course_code,c.can_self_approve_scored_forms FROM learning.course_content_authority c
    JOIN mapping.reviewer_account a ON lower(a.email)=lower(c.reviewer_email)
    WHERE lower(a.email)=lower($1) AND a.status='active' AND c.status='active'`,[email]);
  const reviewCourses=sharedCourseCodes.filter(code=>rows.some(row=>row.course_code===code));
  return {createCourses:await isCatalogAdmin(db,email)?sharedCourseCodes:reviewCourses,reviewCourses,
    selfApproveCourses:reviewCourses.filter(code=>rows.some(row=>row.course_code===code&&row.can_self_approve_scored_forms))};
}

export async function assertSharedCourse(db,email,course) {
  if(!sharedCourseCodes.includes(course))throw new FormAuthoringError('SHARED_COURSE_INVALID','Chọn khóa hợp lệ cho Kho chung.',[],400);
  if(!(await sharedCourseCapabilities(db,email)).createCourses.includes(course))
    throw new FormAuthoringError('SHARED_COURSE_ACCESS_DENIED','Bạn chưa có quyền soạn bài Kho chung cho khóa này.',[],403);
}
