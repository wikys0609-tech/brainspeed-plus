import React, { useState } from 'react';
import ratingAllImage from '../assets/rating_all.gif';

interface GameRatingInfoProps {
  onlyBadge?: boolean;
}

export const GameRatingInfo: React.FC<GameRatingInfoProps> = ({ onlyBadge = false }) => {
  const [imageError, setImageError] = useState(false);

  const handleImageError = () => {
    setImageError(true);
  };

  const ratingBadge = (
    <div className="grac-rating-badge-container">
      {!imageError ? (
        <img
          src={ratingAllImage}
          alt="전체이용가"
          className="grac-rating-image"
          onError={handleImageError}
        />
      ) : (
        <div className="grac-rating-fallback">
          <div className="grac-fallback-inner">
            <span className="grac-fallback-age">전체</span>
            <span className="grac-fallback-label">이용가</span>
          </div>
        </div>
      )}
    </div>
  );

  if (onlyBadge) {
    return ratingBadge;
  }

  return (
    <div className="grac-info-container">
      <div className="grac-info-header">
        {ratingBadge}
        <div className="grac-info-header-text">
          <h4 className="grac-title-text">두뇌 스피드 테스트</h4>
          <span className="grac-badge-inline">전체이용가</span>
        </div>
      </div>
      
      <table className="grac-info-table">
        <tbody>
          <tr>
            <th>게임명</th>
            <td>두뇌 스피드 테스트</td>
          </tr>
          <tr>
            <th>이용등급</th>
            <td>전체이용가</td>
          </tr>
          <tr>
            <th>등급분류번호</th>
            <td>심의 예정 {/* TODO: 2.0 등급 재취득 후 교체 필요 */}</td>
          </tr>
          <tr>
            <th>등급분류일자</th>
            <td>심의 예정 {/* TODO: 2.0 등급 재취득 후 교체 필요 */}</td>
          </tr>
          <tr>
            <th>제작</th>
            <td>개인 제작 {/* TODO: 출시 전 대표자명 등 상세 제작정보 추가 */}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};
export default GameRatingInfo;
