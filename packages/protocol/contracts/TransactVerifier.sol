// SPDX-License-Identifier: GPL-3.0
/*
    Copyright 2021 0KIMS association.

    This file is generated with [snarkJS](https://github.com/iden3/snarkjs).

    snarkJS is a free software: you can redistribute it and/or modify it
    under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    snarkJS is distributed in the hope that it will be useful, but WITHOUT
    ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
    or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public
    License for more details.

    You should have received a copy of the GNU General Public License
    along with snarkJS. If not, see <https://www.gnu.org/licenses/>.
*/

pragma solidity >=0.7.0 <0.9.0;

contract TransactVerifier {
    // Scalar field size
    uint256 constant r    = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    // Base field size
    uint256 constant q   = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    // Verification Key data
    uint256 constant alphax  = 16866630861397535508061268716364694259249938394339511734875352420580686553501;
    uint256 constant alphay  = 17520716159822560737285056959632284245058124741522968592348310279469928232716;
    uint256 constant betax1  = 3856413861865682259406125593772489970436434033350188456453307594579869731190;
    uint256 constant betax2  = 13988176118895483991861904558084572334100786266952036084176540328185395712741;
    uint256 constant betay1  = 334362448847226824842955750527379103975927130063427606928961190725655324074;
    uint256 constant betay2  = 3547607775902656698424692392688161652233723705721377817271388643195866972830;
    uint256 constant gammax1 = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 constant gammax2 = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 constant gammay1 = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 constant gammay2 = 8495653923123431417604973247489272438418190587263600148770280649306958101930;
    uint256 constant deltax1 = 4008201956393266006804618064436555346316200024324015427273260460377514771187;
    uint256 constant deltax2 = 10553408502428278124321745734315812276723821717733076331607263164127700028023;
    uint256 constant deltay1 = 8009909600015732448549099486569071990373254237592634779618140391566427873342;
    uint256 constant deltay2 = 15776636470990282339229797734998354844735279356595183585222364494788454549215;

    
    uint256 constant IC0x = 12485136506727987587634630622276159359785883988325605692849585781222282201320;
    uint256 constant IC0y = 2687164958958898222412986229829364718967075162547090788117493856540670677277;
    
    uint256 constant IC1x = 8951719332774700464971211333447000417221789784761410246880603104482736437774;
    uint256 constant IC1y = 7985527894724626771487320027552059473583214871463479756085899807014793064452;
    
    uint256 constant IC2x = 21300793103145883934378019210949887016766933128420054548754554937383294293672;
    uint256 constant IC2y = 5891067845559001739923107135828463088037329637054236746715615125594556395001;
    
    uint256 constant IC3x = 14860250295686278968779886870869925778029077804148418267983628159765595175672;
    uint256 constant IC3y = 20393265794860713633379633433082222679660027805385940320551866449404328101576;
    
    uint256 constant IC4x = 18432852469668533917079146846183922552102978529192882822802900627857358660488;
    uint256 constant IC4y = 8535164971298696787234376840063634604933700924041430688397105934502499216072;
    
    uint256 constant IC5x = 20891033044683217277246052075013079280785595011015153086398598814234226260431;
    uint256 constant IC5y = 20924737859540711091881196584479492620140681847124328161766550224648872764706;
    
    uint256 constant IC6x = 16004276376643802910827340025079856722969043056395856860050910885361088573660;
    uint256 constant IC6y = 19849115466890740375795454753721323085657208751008739343007930803910339534652;
    
    uint256 constant IC7x = 8785967072300787939692283859011123561919567724440910432574479516484717440624;
    uint256 constant IC7y = 381920201633088259753988349022805668925214989759215875264388477076140108763;
    
    uint256 constant IC8x = 1472508723619104994692996605757427200657220924444621963921424893609584475617;
    uint256 constant IC8y = 1178275303448369396809511765594877588789885287078369265343384986278504294471;
    
    uint256 constant IC9x = 3771328395099730574011032632887988947806452509821432386129029614667618623379;
    uint256 constant IC9y = 15080510380844515464919958600565783991267546522812290026210634378559048491092;
    
    uint256 constant IC10x = 2080278518332341490668727830536620556896986078937997287168628118645081076691;
    uint256 constant IC10y = 4100889419016524917978121747860219994609142124249597038340665476296430375462;
    
    uint256 constant IC11x = 10467586526060839796491045668313910940778140518611054515926012714262656342661;
    uint256 constant IC11y = 14312769484327987398945917353610133507302479877830138992756812405901885894989;
    
    uint256 constant IC12x = 4296668586875856989679834405201590190781704084456130623928697470893314986279;
    uint256 constant IC12y = 15558755001046422797661512847623044603423356796196006054275540758781382183932;
    
    uint256 constant IC13x = 9515058983242830029263284499878062233918852138245709255583650115313822146282;
    uint256 constant IC13y = 5128845699749761680635172029382305230115796178396262552191999551704224334739;
    
    uint256 constant IC14x = 1830103239142365916240255738082910619430383687952928845161527350521136926125;
    uint256 constant IC14y = 8166757161145874196594254571548251433638016942977863520154826091886215911809;
    
 
    // Memory data
    uint16 constant pVk = 0;
    uint16 constant pPairing = 128;

    uint16 constant pLastMem = 896;

    function verifyProof(uint[2] calldata _pA, uint[2][2] calldata _pB, uint[2] calldata _pC, uint[14] calldata _pubSignals) public view returns (bool) {
        assembly {
            function checkField(v) {
                if iszero(lt(v, r)) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }
            
            // G1 function to multiply a G1 value(x,y) to value in an address
            function g1_mulAccC(pR, x, y, s) {
                let success
                let mIn := mload(0x40)
                mstore(mIn, x)
                mstore(add(mIn, 32), y)
                mstore(add(mIn, 64), s)

                success := staticcall(sub(gas(), 2000), 7, mIn, 96, mIn, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }

                mstore(add(mIn, 64), mload(pR))
                mstore(add(mIn, 96), mload(add(pR, 32)))

                success := staticcall(sub(gas(), 2000), 6, mIn, 128, pR, 64)

                if iszero(success) {
                    mstore(0, 0)
                    return(0, 0x20)
                }
            }

            function checkPairing(pA, pB, pC, pubSignals, pMem) -> isOk {
                let _pPairing := add(pMem, pPairing)
                let _pVk := add(pMem, pVk)

                mstore(_pVk, IC0x)
                mstore(add(_pVk, 32), IC0y)

                // Compute the linear combination vk_x
                
                g1_mulAccC(_pVk, IC1x, IC1y, calldataload(add(pubSignals, 0)))
                
                g1_mulAccC(_pVk, IC2x, IC2y, calldataload(add(pubSignals, 32)))
                
                g1_mulAccC(_pVk, IC3x, IC3y, calldataload(add(pubSignals, 64)))
                
                g1_mulAccC(_pVk, IC4x, IC4y, calldataload(add(pubSignals, 96)))
                
                g1_mulAccC(_pVk, IC5x, IC5y, calldataload(add(pubSignals, 128)))
                
                g1_mulAccC(_pVk, IC6x, IC6y, calldataload(add(pubSignals, 160)))
                
                g1_mulAccC(_pVk, IC7x, IC7y, calldataload(add(pubSignals, 192)))
                
                g1_mulAccC(_pVk, IC8x, IC8y, calldataload(add(pubSignals, 224)))
                
                g1_mulAccC(_pVk, IC9x, IC9y, calldataload(add(pubSignals, 256)))
                
                g1_mulAccC(_pVk, IC10x, IC10y, calldataload(add(pubSignals, 288)))
                
                g1_mulAccC(_pVk, IC11x, IC11y, calldataload(add(pubSignals, 320)))
                
                g1_mulAccC(_pVk, IC12x, IC12y, calldataload(add(pubSignals, 352)))
                
                g1_mulAccC(_pVk, IC13x, IC13y, calldataload(add(pubSignals, 384)))
                
                g1_mulAccC(_pVk, IC14x, IC14y, calldataload(add(pubSignals, 416)))
                

                // -A
                mstore(_pPairing, calldataload(pA))
                mstore(add(_pPairing, 32), mod(sub(q, calldataload(add(pA, 32))), q))

                // B
                mstore(add(_pPairing, 64), calldataload(pB))
                mstore(add(_pPairing, 96), calldataload(add(pB, 32)))
                mstore(add(_pPairing, 128), calldataload(add(pB, 64)))
                mstore(add(_pPairing, 160), calldataload(add(pB, 96)))

                // alpha1
                mstore(add(_pPairing, 192), alphax)
                mstore(add(_pPairing, 224), alphay)

                // beta2
                mstore(add(_pPairing, 256), betax1)
                mstore(add(_pPairing, 288), betax2)
                mstore(add(_pPairing, 320), betay1)
                mstore(add(_pPairing, 352), betay2)

                // vk_x
                mstore(add(_pPairing, 384), mload(add(pMem, pVk)))
                mstore(add(_pPairing, 416), mload(add(pMem, add(pVk, 32))))


                // gamma2
                mstore(add(_pPairing, 448), gammax1)
                mstore(add(_pPairing, 480), gammax2)
                mstore(add(_pPairing, 512), gammay1)
                mstore(add(_pPairing, 544), gammay2)

                // C
                mstore(add(_pPairing, 576), calldataload(pC))
                mstore(add(_pPairing, 608), calldataload(add(pC, 32)))

                // delta2
                mstore(add(_pPairing, 640), deltax1)
                mstore(add(_pPairing, 672), deltax2)
                mstore(add(_pPairing, 704), deltay1)
                mstore(add(_pPairing, 736), deltay2)


                let success := staticcall(sub(gas(), 2000), 8, _pPairing, 768, _pPairing, 0x20)

                isOk := and(success, mload(_pPairing))
            }

            let pMem := mload(0x40)
            mstore(0x40, add(pMem, pLastMem))

            // Validate that all evaluations ∈ F
            
            checkField(calldataload(add(_pubSignals, 0)))
            
            checkField(calldataload(add(_pubSignals, 32)))
            
            checkField(calldataload(add(_pubSignals, 64)))
            
            checkField(calldataload(add(_pubSignals, 96)))
            
            checkField(calldataload(add(_pubSignals, 128)))
            
            checkField(calldataload(add(_pubSignals, 160)))
            
            checkField(calldataload(add(_pubSignals, 192)))
            
            checkField(calldataload(add(_pubSignals, 224)))
            
            checkField(calldataload(add(_pubSignals, 256)))
            
            checkField(calldataload(add(_pubSignals, 288)))
            
            checkField(calldataload(add(_pubSignals, 320)))
            
            checkField(calldataload(add(_pubSignals, 352)))
            
            checkField(calldataload(add(_pubSignals, 384)))
            
            checkField(calldataload(add(_pubSignals, 416)))
            

            // Validate all evaluations
            let isValid := checkPairing(_pA, _pB, _pC, _pubSignals, pMem)

            mstore(0, isValid)
             return(0, 0x20)
         }
     }
 }
